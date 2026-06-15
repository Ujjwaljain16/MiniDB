Yes. This is exactly the kind of document you should have for viva. But I would make it **much more than a static architecture document**.

The README is "what MiniDB is".

This document should be:

> **"The Story of Building MiniDB: Architecture, Evolution, Engineering Decisions, Bugs, Tradeoffs, and Lessons Learned."**

A viva panel does not only ask "what is a B+ Tree?" They ask:

* Why did you choose this design?
* What went wrong while building it?
* How did you debug it?
* What are the limitations?
* What would PostgreSQL do differently?
* How did your architecture evolve?

Given the journey we had (root persistence bug, page header corruption, ANALYZE statistics bug, index backfill issue, Heap/B+Tree interleaving issue, WAL undo bug, vectorization bottlenecks, benchmark stabilization, etc.), this document should capture all of that.

It will be very large (likely 30,000+ words), so I will split it into parts.

---

# MiniDB: Engineering Journey, Architecture & Viva Defense Guide

## Preface: Why MiniDB Exists

MiniDB was not designed as a feature-complete competitor to PostgreSQL or SQLite. It was built as a ground-up exploration of the fundamental ideas that power modern relational database systems.

The primary objective was to answer a simple question:

> What actually happens inside a database after we execute `SELECT * FROM users WHERE id = 5`?

Most application developers interact with databases through high-level abstractions such as ORMs and SQL APIs. The complexity beneath that interface remains hidden:

* How are rows physically stored?
* How does the database know where a tuple exists on disk?
* Why are B+ Trees used instead of hash tables?
* How does a database avoid reading the entire disk for every query?
* What happens when two users modify the same row simultaneously?
* What happens if the machine loses power in the middle of a transaction?

MiniDB was built to answer those questions by implementing every major component of a relational database from scratch.

---

# Overall System Evolution

The final MiniDB engine consists of the following major subsystems:

```
                         SQL Query
                              |
                              v
                      SQL Frontend
                 (Parser + Binder + AST)
                              |
                              v
                       Logical Planner
                              |
                              v
                   Cost-Based Optimizer
                              |
                              v
                     Physical Planner
                              |
                              v
             +-------------------------------+
             |       Execution Engines        |
             |                                |
             |  Volcano       Vectorized      |
             +-------------------------------+
                              |
                              v
                 Transaction & Lock Manager
                              |
                              v
                      Buffer Pool (LRU-K)
                              |
                              v
              Heap Storage + B+ Tree Index Pages
                              |
                              v
                        Disk Manager
                              |
                              v
                     Write Ahead Logging
                              |
                              v
                   ARIES Crash Recovery
```

The system eventually reached approximately the same architectural layering that is used by real relational systems:

* PostgreSQL: Parser → Planner → Executor → Storage → WAL
* SQLite: SQL Compiler → Virtual Machine → Pager → B-tree
* MiniDB: Parser → Optimizer → Operator Engine → Buffer Manager → Disk

Although simplified, the architectural boundaries were intentionally maintained.

---

# Chapter 1: Storage Engine — Building the Foundation

Every database begins with a simple problem:

**How do we store arbitrary records on disk efficiently?**

A naive design would be to write rows sequentially:

```
Page
--------------------------------
| User1 | User2 | User3 | User4 |
--------------------------------
```

This works until we encounter a real-world problem.

Suppose:

```
User2 = "John"
```

is updated to:

```
User2 = "Johnathan Christopher Smith"
```

The new tuple is larger.

Every tuple after it must shift.

```
Before:
[User1][User2][User3][User4]

After:
[User1][Bigger User2][User3 moved][User4 moved]
```

Now every external pointer into the page becomes invalid.

This is unacceptable because indexes depend on stable references.

---

# The Decision: Slotted Pages

MiniDB uses a slotted-page architecture.

A page consists of three regions:

```
+------------------------------------------------+
|                 Header                          |
|------------------------------------------------|
| Tuple Area                                      |
|  [Tuple1][Tuple2][Tuple3]                       |
|                 Free Space                      |
|                         [Slot3][Slot2][Slot1]   |
+------------------------------------------------+
```

The tuples grow forward.

The slot directory grows backwards.

A Record Identifier (RID) does not point directly to a byte offset.

Instead:

```
RID = (PageID, SlotID)
```

For example:

```
RID(42, 5)
```

means:

* Page 42
* Slot 5

The slot contains the actual byte offset:

```
Slot 5:
{
    offset: 1200,
    length: 64
}
```

If the tuple moves during compaction:

```
Old:
Slot 5 -> offset 1200

After compaction:
Slot 5 -> offset 800
```

The RID remains identical.

This is one of the most fundamental ideas in database storage.

---

# A Critical Bug We Discovered: Page Header Corruption

One of the most serious bugs discovered during final auditing involved the page header layout.

Initially, certain metadata fields used hardcoded offsets:

```
PageLSN = offset 8
Free Space = offset 16
Page Type = offset 16
```

This caused an overlap.

When recovery updated the PageLSN, it accidentally overwrote page metadata.

The consequences were catastrophic:

* Heap pages could be interpreted incorrectly.
* B+ Tree pages could lose identity.
* Recovery could apply changes to corrupted structures.

The fix was architectural.

Instead of using scattered magic numbers:

```typescript
buffer.writeBigInt64BE(lsn, 8);
```

we centralized all page layout definitions:

```typescript
class Page {
    static readonly PAGE_LSN_OFFSET = ...
    static readonly PAGE_TYPE_OFFSET = ...
}
```

Now every component references a single source of truth.

---

# Heap File Design

A table in MiniDB is implemented as a Heap File.

A heap file is simply a collection of slotted pages:

```
users table

Page 1
-------------
RID 1: Alice
RID 2: Bob

Page 2
-------------
RID 3: Charlie
RID 4: David
```

The heap file supports:

* Insert
* Lookup by RID
* Delete
* Sequential Scan

The important architectural decision:

**Heap pages and B+ Tree pages coexist inside the same database file.**

This reduced file-management complexity but introduced a difficult bug.

---

# Bug: Heap Scanner Reading B+ Tree Pages

During the large 10,000-row ANALYZE benchmark, the system crashed.

The HeapFile sequential scanner assumed:

```
Every page in the database file is a heap page.
```

This assumption was false.

The storage file looked like:

```
Page 0 : Heap
Page 1 : Heap
Page 2 : B+ Tree root
Page 3 : B+ Tree leaf
Page 4 : Heap
```

The scanner reached Page 2.

It attempted:

```
Deserialize B+ Tree binary bytes as a tuple.
```

Result:

```
Out-of-bounds memory reads.
Corrupted tuples.
ANALYZE failures.
```

The solution was to introduce explicit page type metadata.

```
PageType:
0 = Heap
1 = B+ Tree Leaf
2 = B+ Tree Internal
```

The HeapFile now performs:

```
if pageType != HEAP:
    skip page
```

This was a major lesson:

> In database systems, metadata is as important as the data itself.

---

# Storage Layer Lessons Learned

By the end of this phase we had:

Implemented:

* 4KB fixed pages
* Slotted-page layout
* Stable RIDs
* Variable-length tuple support
* Heap files
* Page type identification

Discovered and fixed:

* Page metadata offset corruption
* Heap/B+ Tree page interleaving failures

Key tradeoff:

The current design uses manual:

```
fetchPage()
unpinPage()
```

management.

This gives maximum control but requires careful exception handling.

Production engines often use RAII-style guards to guarantee pages are always released.

---

**End of Part 1**

Next parts will cover:

* **Part 2:** B+ Tree indexing journey, root persistence bug, splits/merges, catalog synchronization, and index benchmarks.
* **Part 3:** SQL layer, optimizer, statistics, ANALYZE evolution, and why the optimizer initially failed to choose indexes.
* **Part 4:** Volcano execution, vectorized execution, performance bottlenecks, and benchmark evolution.
* **Part 5:** Transactions, deadlocks, Strict 2PL design decisions.
* **Part 6:** WAL, ARIES recovery, terrifying recovery bugs, crash testing, and production audit.
* **Part 7:** Final architecture decisions, limitations, viva questions, and engineering lessons.

This will become the definitive "how MiniDB was actually built" document, not just a README.
# MiniDB Engineering Journey, Architecture & Viva Defense Guide

# Part 2 — B+ Tree Indexing: From Linear Scans to Logarithmic Search

---

# Chapter 2: Why We Needed an Index

After implementing the Heap File, MiniDB could successfully store tables and perform sequential scans.

For example:

```sql
SELECT * FROM users WHERE id = 50000;
```

Initially, the only execution strategy available was:

```
SeqScan(users)

Page 1
  ↓
Page 2
  ↓
Page 3
  ↓
...
Page 615
```

The database had no information about where `id = 50000` was located.

Therefore, the only correct algorithm was:

```text
for every page:
    for every tuple:
        if tuple.id == 50000:
            return tuple
```

---

## Complexity Problem

For a table with `N` records:

```
Sequential Scan = O(N)
```

This is acceptable for small tables:

```
3 rows → almost instant
100 rows → instant
```

But at scale:

```
100,000 rows
```

The query must inspect thousands of tuples.

Our benchmark demonstrated this:

```
Dataset:
100,000 users

Query:
SELECT * FROM users WHERE id = 50000


Sequential Scan:
≈ 164 ms
```

The problem was not computation.

The problem was **I/O and unnecessary memory accesses**.

We were reading hundreds of pages even though only one record was needed.

---

# Why Not Use a Hash Index?

A common viva question:

> Why did you choose B+ Trees instead of Hash Tables?

A hash index gives:

```
id = 50000

hash(50000)
        |
        v
      Bucket
        |
        v
       RID
```

Point lookup:

```
Average:
O(1)
```

Sounds perfect.

---

## The Hidden Problem: Range Queries

Consider:

```sql
SELECT * 
FROM users
WHERE id > 50000 AND id < 60000;
```

A hash index has no notion of ordering.

The keys:

```
50001
50002
50003
...
59999
```

are distributed randomly across buckets:

```
Bucket 1:
  50042

Bucket 9:
  59900

Bucket 4:
  50123
```

There is no efficient way to find all values in a range.

The database falls back to:

```
Scan every bucket
```

---

# Why B+ Trees Win

B+ Trees maintain sorted order.

A simplified structure:

```
                  [40 | 80]
                  /       \
                 /         \
                /           \
         [10 20 30]      [50 60 70]
                           |
                           |
                      [90 100 110]
```

The actual MiniDB implementation stores:

* Internal nodes → separator keys + child pointers
* Leaf nodes → keys + RIDs

---

# Leaf Node Design

The leaves contain the actual lookup information.

Example:

```
Leaf Page

+----------------+
| Key | RID       |
|----------------|
| 10  | (1,5)     |
| 20  | (2,7)     |
| 30  | (4,2)     |
+----------------+
```

The RID tells us exactly where the tuple exists:

```
RID = (PageID, SlotID)
```

Then:

```
B+ Tree
   |
   v
Heap File
   |
   v
Actual Tuple
```

This is called an:

## Unclustered Index

The table data is physically separate from the index.

---

# The Critical Advantage: Linked Leaves

The most important B+ Tree property is that all leaf nodes are connected.

Example:

```
Leaf 1                Leaf 2                Leaf 3

[1,2,3,4]
     |
     v
[5,6,7,8]
     |
     v
[9,10,11,12]
```

Therefore a range query works as:

```
Find first key >= 50000

        |
        v

Traverse leaf siblings sequentially
```

Complexity:

```
Search:
O(log N)

Range Scan:
O(log N + K)
```

Where:

```
K = number of returned records
```

---

# B+ Tree Page Layout in MiniDB

MiniDB stores B+ Tree nodes inside the same 4KB page system used by Heap Files.

There is no separate index file.

The storage file may look like:

```
minidb.db


Page 0:
Heap Data


Page 1:
Heap Data


Page 2:
B+ Tree Root


Page 3:
B+ Tree Leaf


Page 4:
Heap Data
```

This simplified disk management because:

```
DiskManager
       |
       |
  4KB Pages
       |
       |
+-------------+
| Heap Pages  |
| B+Tree Pages|
+-------------+
```

However, this design later caused a major bug.

---

# Insertion Algorithm

When inserting:

```sql
INSERT INTO users VALUES(50000, 25);
```

The flow becomes:

```
InsertOp
   |
   |
HeapFile.insertTuple()
   |
   |
returns RID
   |
   |
Update B+ Tree
```

Example:

```
Insert:

Key = 50000

RID = (Page 100, Slot 8)


Leaf:

Before:
[10000, 20000, 30000]


After:
[10000, 20000, 30000, 50000]
```

---

# What Happens When a Node Is Full?

A B+ Tree node has a fixed capacity because it occupies exactly one page.

Eventually:

```
Leaf:

[1,2,3,4,5,6,7,8]
```

receives:

```
Insert 9
```

There is no space.

---

# Node Split

The node is divided:

Before:

```
        [1 2 3 4 5 6 7 8]
```

After:

```
      Parent
       [5]

      /   \
     /     \

[1 2 3 4] [5 6 7 8]
```

The middle separator key is pushed upward.

---

# The Root Split Case

The most dangerous operation is when the root itself becomes full.

Initially:

```
Root

[1 2 3 4 5 6 7 8]
```

After splitting:

```
              New Root
                 [5]


              /       \


     Old Root        New Leaf

 [1 2 3 4]       [5 6 7 8]
```

The database must now remember:

```
Root Page ID changed
```

This led to one of the most severe bugs discovered during MiniDB's final audit.

---

# The Root Persistence Catastrophe

Originally, the B+ Tree maintained:

```typescript
this.rootPageId = newRoot;
```

inside memory.

Everything worked perfectly.

The tests passed.

Queries succeeded.

Indexes were fast.

But there was a hidden disaster.

---

## The Crash Scenario

Imagine:

```
Database Running


Root Page:
Page 2
```

Insert enough records.

The tree grows.

The new root becomes:

```
Page 120
```

Memory:

```
rootPageId = 120
```

Everything is still correct.

---

## System Restart

The database shuts down.

The in-memory variable disappears.

During startup:

```
Catalog loads index metadata
```

But the catalog still contained:

```
rootPageId = 2
```

because nobody informed it that the root changed.

The result:

```
Catalog
   |
   |
Old Root Page
   |
   |
Corrupted Index Traversal
```

The B+ Tree would begin searching from a stale root.

This is silent corruption.

The worst category of database bug.

---

# The Fix: Root Change Callback

A naive fix would be:

```
B+ Tree
   |
   |
Catalog
```

But that creates circular dependencies.

Instead we introduced an inversion of control pattern.

The B+ Tree receives:

```typescript
onRootChange(newRoot)
```

as a callback.

Whenever the root changes:

```
B+ Tree Split

      |
      |
setRoot(newRoot)

      |
      |
onRootChange()

      |
      |
Catalog.updateIndexRoot()

      |
      |
catalog.json flushed
```

Now the root is durable.

---

# Regression Testing the Fix

A dedicated persistence test was written:

```
Create Index

Insert 1000 keys

Force root splits

Shutdown database

Restart database

Reload catalog

Search all 1000 keys
```

Result:

```
1000 / 1000 keys found successfully
```

The root tracking issue was permanently eliminated.

---

# Deletion, Underflow, and Rebalancing

Insertion is not enough.

Consider:

```
Before deletion:

[1 2 3 4]
[5 6 7 8]
```

Delete several keys:

```
[1]
[5 6 7 8]
```

The left node becomes under-utilized.

MiniDB follows traditional B+ Tree balancing:

## Borrowing

If the sibling has extra keys:

```
Before:

Left:
[1]

Right:
[5 6 7 8]


After:

Left:
[1 5]

Right:
[6 7 8]
```

---

## Merging

If borrowing is impossible:

```
Before:

[1]
[2]


After:

[1 2]
```

The parent pointer is removed.

---

# The Optimizer Integration

A B+ Tree is useless unless the optimizer knows when to use it.

The optimizer checks:

```
Does an index exist?
          |
          v
Estimate predicate selectivity
          |
          v
Compare costs

Index Cost vs SeqScan Cost
```

Example:

```
100,000 rows

id = 50000


Selectivity:

1 / 100000
=
0.00001
```

Estimated:

```
SeqScan cost:
≈ 100


Index cost:
≈ 4
```

Therefore:

```
Physical Plan:

Project
   |
Filter
   |
IndexScan
```

---

# Benchmark Results

Final benchmark:

```
100,000 rows

Query:
SELECT * FROM users WHERE id = 50000


Sequential Scan:
164.22 ms


B+ Tree:
0.03 ms


Speedup:
~5000x
```

---

# B+ Tree Lessons Learned

## What We Implemented

* Unclustered B+ Tree
* Internal and leaf pages
* Point lookups
* Range scans
* Splits
* Merges
* Borrowing
* Root growth and shrinking
* Persistent root tracking
* Cost-based optimizer integration

---

## Major Bugs We Discovered

### 1. Root Persistence Bug

**Impact:** Silent index corruption after restart.

**Fix:** `onRootChange` callback → `Catalog.updateIndexRoot`.

---

### 2. Heap and Index Page Interleaving Bug

**Impact:** Heap scans attempted to interpret B+ Tree pages as tuples.

**Fix:** Added explicit page type metadata and validation.

---

## Viva Takeaway

The biggest lesson from building the B+ Tree was:

> The difficult part of databases is not implementing the data structure itself. The real challenge is maintaining consistency between memory, disk, metadata, and recovery boundaries.

A B+ Tree that works in memory is easy.
A B+ Tree that survives crashes, restarts, splits, and millions of operations is what turns it into a real database component.

---

# End of Part 2

Next:

## Part 3 — SQL Layer, Binder, Query Planning, Cost-Based Optimization, and the Bugs That Prevented Index Selection

We will cover:

* How raw SQL becomes executable operators
* Building the AST using discriminated unions
* The Binder and semantic validation
* Logical vs Physical plans
* Cost model design
* `ANALYZE` statistics
* Why the optimizer initially always chose `SeqScan`
* The missing column statistics bug
* The `CREATE INDEX` backfill limitation
* The final 100,000-row optimizer victory where `phys_index_scan` was chosen automatically
# MiniDB Engineering Journey, Architecture & Viva Defense Guide

# Part 3 — SQL Layer, Query Planning & Cost-Based Optimization

---

# Chapter 3: The Journey from SQL Text to an Executable Query

A relational database is not merely a storage engine. The true power of a database lies in its ability to accept a high-level declarative language like SQL:

```sql
SELECT * 
FROM users 
WHERE id = 50000;
```

The user does not specify:

* Which pages should be read.
* Whether to use an index.
* Which algorithm should execute the query.
* How memory should be allocated.
* Which locks must be acquired.

The user only describes **what** they want.

The database must decide **how** to obtain it.

This transformation from a human-readable SQL statement into low-level physical operations is one of the most sophisticated parts of any database.

The complete pipeline in MiniDB is:

```
Raw SQL String
       |
       v
SQL Parser
       |
       v
Abstract Syntax Tree (AST)
       |
       v
Binder (Semantic Analysis)
       |
       v
Bound Query Representation
       |
       v
Logical Plan
       |
       v
Cost-Based Optimizer
       |
       v
Physical Plan
       |
       v
Execution Engine
```

---

# 1. SQL Parsing — Turning Text into Structure

## The Problem

A SQL query begins as nothing more than a string.

For example:

```text
"SELECT id FROM users WHERE age > 18"
```

Computers cannot execute strings.

The database first needs to understand the grammatical structure.

---

## Why We Did Not Execute SQL Directly

A naive approach would be:

```javascript
if (query.includes("SELECT")) {
    // execute select
}
```

This immediately fails.

Consider:

```sql
SELECT id FROM users WHERE age > 18;
```

versus:

```sql
SELECT id 
FROM users 
WHERE age > 18;
```

The formatting is different, but the meaning is identical.

Real databases therefore use a parser based on a formal grammar.

---

# Using sql-parser-cst

MiniDB uses `sql-parser-cst` as the frontend parser.

Its responsibility is to perform:

* Lexical analysis (tokens)
* Syntax validation
* Concrete Syntax Tree (CST) generation

Example:

```sql
SELECT id FROM users WHERE age > 18;
```

becomes a tree similar to:

```
SELECT
 |
 +-- Projection
 |       |
 |       id
 |
 +-- FROM
 |       |
 |      users
 |
 +-- WHERE
         |
        age > 18
```

---

# Why We Built Our Own AST

An important architectural decision:

We did **not** allow the entire database to depend on the third-party CST.

Why?

Because external parser structures:

* Are dialect-specific.
* Contain unnecessary grammar information.
* Are difficult to evolve.
* Do not represent database semantics.

Therefore, MiniDB introduces its own internal AST.

---

# AST Design

The AST was implemented using TypeScript discriminated unions.

Example:

```typescript
type Statement =
    | SelectStatement
    | InsertStatement
    | DeleteStatement
    | CreateTableStatement;
```

Each node has a `type` field:

```typescript
{
    type: "SELECT",
    columns: ["id"],
    table: "users",
    predicate: ...
}
```

This gives compile-time safety.

---

# Important Engineering Fix — Eliminating `any`

During early parser implementation, a major code-quality issue appeared.

The external parser returned dynamic CST objects.

The easy implementation was:

```typescript
const node: any = parser.parse(sql);
```

This worked.

However, it completely bypassed TypeScript safety.

The danger:

```
Parser changes structure
          |
          v
Compiler does not warn
          |
          v
Runtime crashes
```

---

## The Final Design

We removed all `any` usage.

Instead:

* Defined explicit CST interfaces.
* Used `unknown`.
* Added runtime type guards.
* Performed safe narrowing.

Example:

```
unknown
    |
    v
Type Guard
    |
    v
CST Node
    |
    v
AST Node
```

The final SQL layer had zero `any` usage.

---

# Supported SQL Features

MiniDB supports:

## DDL

```
CREATE TABLE
CREATE INDEX
DROP
```

---

## DML

```
INSERT
DELETE
```

---

## Queries

```
SELECT
WHERE
INNER JOIN
EXPLAIN
EXPLAIN ANALYZE
ANALYZE
```

---

# 2. Binder — Semantic Analysis

Parsing only answers:

> Is this SQL grammatically valid?

It does not answer:

> Does this query make sense?

Example:

```sql
SELECT salary FROM users;
```

The parser accepts it.

But what if:

```
users
-----
id
name
age
```

There is no `salary`.

The error should occur before execution.

---

# The Binder's Responsibility

The Binder converts the AST into a semantically verified representation.

It communicates with the Catalog.

---

## Table Validation

Example:

```sql
SELECT * FROM employees;
```

Binder checks:

```
Catalog
   |
   v
Does employees exist?
```

If not:

```
BindError:
TableNotFound
```

---

# Column Validation

Example:

```sql
SELECT salary FROM users;
```

Result:

```
BindError:
ColumnNotFound
```

---

# Ambiguous Columns

Consider:

```sql
SELECT id
FROM users
JOIN orders
ON users.id = orders.user_id;
```

Both tables may contain `id`.

The binder detects:

```
users.id
orders.id

        |
        v

ColumnAmbiguous
```

---

# Alias Handling

The binder maintains a scope map.

Example:

```sql
SELECT u.id
FROM users u;
```

Creates:

```
Scope

u
 |
users
```

So references can be resolved correctly.

---

# Why Binding Is Important

Without binding:

```
Parser
   |
   v
Executor
```

The executor would constantly ask:

```
Does this column exist?
Which table is this from?
What type is this?
```

This creates runtime failures.

Binding moves all errors earlier.

---

# 3. Logical Planning

After binding, the query is converted into a logical relational plan.

The logical plan describes:

> What operations are required?

but not:

> How they should be executed.

---

Example:

```sql
SELECT *
FROM users
WHERE age > 18;
```

Logical representation:

```
LogicalProject
       |
LogicalFilter
       |
LogicalScan(users)
```

Notice:

It does not say:

* Sequential scan?
* Index scan?
* Hash join?
* Nested loop?

Those decisions belong to the optimizer.

---

# 4. The Need for a Cost-Based Optimizer

Initially, every query used:

```
SeqScan
```

This was correct.

But inefficient.

Example:

```
users table

100,000 rows
```

Query:

```sql
SELECT * FROM users WHERE id = 50000;
```

Sequential scan:

```
Read all pages
Check every tuple
Return one row
```

Cost:

```
O(N)
```

---

# Cost Model Design

MiniDB introduces a simple cost model.

It estimates:

* Number of rows.
* Predicate selectivity.
* Scan cost.

---

# Statistics Collection via ANALYZE

The optimizer requires statistics.

Example:

```sql
ANALYZE users;
```

This performs a table scan and records:

```
TableStats

RowCount = 100000

ColumnStats:

id:
    min = 1
    max = 100000
    nDistinct = 100000
```

---

# The Critical Bug — ANALYZE Did Nothing

One of the most important optimizer bugs appeared during final testing.

We had:

```
CREATE INDEX idx_id ON users(id);
```

Then:

```sql
EXPLAIN SELECT *
FROM users
WHERE id = 50000;
```

Expected:

```
Project
 |
IndexScan
```

Actual:

```
Project
 |
Filter
 |
SeqScan
```

---

# Debugging the Problem

The optimizer logic looked correct.

It checked:

```
Does index exist?
      |
      YES
      |
Estimate cost
```

However, the estimated selectivity was wrong.

---

The reason:

`ANALYZE` was storing:

```
columnStats = {}
```

The table row count existed.

But no column-level statistics were generated.

Therefore:

```
Unknown predicate
        |
        v
Fallback selectivity = 10%
```

Example:

```
100000 rows

id = 50000

Estimated rows:

100000 * 0.1
= 10000 rows
```

The optimizer believed:

```
Index not worth it
```

---

# The Fix

We modified `ANALYZE`.

During the table scan, it now calculates:

```
min
max
nDistinct
```

for every column.

For the same table:

```
id:

min = 1
max = 100000
nDistinct = 100000
```

Now:

```
id = 50000

Selectivity:

1 / nDistinct

= 0.00001
```

Estimated rows:

```
100000 × 0.00001

= 1 row
```

---

# Cost Comparison

The optimizer now compares:

```
SeqScan

Read entire table

Cost ≈ 100
```

versus:

```
IndexScan

B+ Tree traversal
+
Tuple lookup

Cost ≈ 4
```

Result:

```
IndexScan wins
```

---

# Final Optimized Plan

After fixing the statistics bug:

```
phys_project
      |
phys_filter
      |
phys_index_scan
```

The actual benchmark showed:

```
SELECT * FROM users WHERE id = 50000;

Rows:
100000

SeqScan:
~164 ms

IndexScan:
~0.03 ms

Speedup:
~5000x
```

---

# Another Important Limitation — Index Backfilling

During testing we discovered another practical issue.

Consider:

```
INSERT 100000 rows
       |
CREATE INDEX
```

The index was empty.

Why?

Because MiniDB's `CREATE INDEX` creates the structure but does not scan existing heap tuples.

It only receives future inserts.

---

Current workflow:

```
CREATE INDEX
       |
INSERT rows
       |
B+ Tree updated incrementally
```

---

Future improvement:

```
CREATE INDEX
       |
Full Heap Scan
       |
Insert every RID into B+ Tree
```

This is how production databases build indexes.

---

# Join Ordering

For multi-table queries, MiniDB implements:

* Exhaustive ordering for ≤3 tables.
* Greedy left-deep ordering for larger joins.

The optimizer chooses the smallest estimated intermediate relations first.

Example:

```
A (100 rows)
B (10000 rows)
C (1,000,000 rows)
```

Preferred:

```
(A JOIN B)
        |
        JOIN C
```

instead of:

```
(C JOIN B)
        |
        JOIN A
```

because the intermediate result is much smaller.

---

# SQL Layer Lessons Learned

## What We Built

* SQL parser
* Strongly typed AST
* Zero `any` TypeScript design
* Binder with semantic checking
* Alias and scope handling
* Logical plans
* Cost-based optimizer
* Statistics collection
* Join ordering
* EXPLAIN and EXPLAIN ANALYZE

---

# Major Bugs Fixed

### 1. Unsafe Parser Types

**Issue:** Dynamic `any` usage.

**Fix:** Custom CST interfaces and type guards.

---

### 2. ANALYZE Statistics Bug

**Issue:**

```
columnStats = {}
```

Result:

```
Optimizer always preferred SeqScan.
```

Fix:

```
Compute min, max, nDistinct.
```

---

### 3. Index Creation Limitation

**Issue:**

Creating an index after data insertion resulted in an empty B+ Tree.

**Decision:**

Documented as a v1 limitation.

---

# Viva Takeaway

The most important realization from this phase was:

> Building a query optimizer is not about implementing clever algorithms; it is about having accurate information.

An index can exist, the B+ Tree can be perfectly implemented, and the executor can support Index Scans—but if the optimizer believes the query will return 10,000 rows instead of 1 row, it will make the wrong decision.

The quality of a database optimizer is directly tied to the quality of its statistics.

---

# End of Part 3

Next:

# Part 4 — Execution Engine Evolution: Volcano Model, Vectorized Engine, Performance Bottlenecks, Benchmark Journey, and the Engineering Decisions Behind a 2x Speedup

Topics covered next:

* Why the Volcano model became a bottleneck
* `open()`, `next()`, `close()` operator lifecycle
* SeqScan, IndexScan, Filter, Join, Insert, Delete operators
* Integration with Lock Manager and WAL
* The RID propagation design evolution (`__rid__` hack → `TupleSlot`)
* Vectorized execution design
* DataChunk layout
* The async bottleneck that destroyed early vectorization performance
* Direct page decoding optimization
* Why strict 2PL reduced vectorization gains
* Real benchmark analysis and Amdahl's Law

# MiniDB Engineering Journey, Architecture & Viva Defense Guide

# Part 4 — Execution Engine Evolution: Volcano Model, Vectorization, Performance Bottlenecks & Engineering Decisions

---

# Chapter 4: The Query Execution Engine — Turning Plans into Real Work

By the time a query reaches the execution engine, the database has already answered several important questions:

* Is the SQL syntactically valid?
* Does the table exist?
* Are columns correctly referenced?
* Is an index beneficial?
* What is the cheapest physical plan?

For example:

```sql
SELECT *
FROM users
WHERE id = 50000;
```

might become:

```
PhysicalProject
        |
PhysicalFilter
        |
PhysicalIndexScan
```

However, this plan is only a description.

The database still needs actual code that can:

* Read pages.
* Decode tuples.
* Evaluate predicates.
* Apply projections.
* Acquire locks.
* Generate WAL records.
* Return rows to the user.

This responsibility belongs to the **Execution Engine**.

---

# 1. The First Execution Model — Volcano Iterator Architecture

MiniDB initially implemented the classical **Volcano Model**, a design introduced in the Volcano database system and still used conceptually in many modern databases.

The philosophy is simple:

> Every operator behaves like an iterator that produces one tuple at a time.

Each operator implements a common interface:

```typescript
interface IOperator {
    open(): Promise<void>;
    next(): Promise<TupleSlot | null>;
    close(): Promise<void>;
}
```

---

# Why Use an Iterator Model?

Imagine a query:

```sql
SELECT name
FROM users
WHERE age > 18;
```

The execution tree becomes:

```
ProjectOp
    |
FilterOp
    |
SeqScanOp
```

Execution starts at the root.

The client asks:

```
ProjectOp.next()
```

Project cannot produce a row itself, so it requests:

```
FilterOp.next()
```

Filter requests:

```
SeqScanOp.next()
```

The scan finally reads a tuple from disk:

```
[1, "Alice", 25]
```

The data then flows upward:

```
              [1, Alice, 25]
                    ↑
              SeqScanOp
                    ↑
          age > 18 ? true
                    ↑
              FilterOp
                    ↑
               ["Alice"]
                    ↑
              ProjectOp
```

This is called the **pull-based execution model**.

---

# Advantages of Volcano

## 1. Extremely Modular

Each operator has one responsibility.

Examples:

```
SeqScanOp
    Reads tuples from heap pages

FilterOp
    Evaluates predicates

ProjectOp
    Selects output columns

JoinOp
    Combines two streams

InsertOp/DeleteOp
    Modify data
```

---

## 2. Pipeline Execution

A query does not need to load an entire table into memory.

Instead:

```
Read one tuple
       |
Process it
       |
Return it
       |
Read next tuple
```

Memory consumption stays small.

---

# 2. The First Major Design Problem — RID Propagation

During implementation, a subtle architectural issue appeared.

---

## The Problem

A normal tuple only contains values.

Example:

```
Tuple:

[1, "Alice", 25]
```

But for DELETE operations, we do not only need the data.

We must know:

```
Which physical row should be deleted?
```

A database identifies rows using:

```
RID = (PageId, SlotId)
```

For example:

```
RID:
Page 120
Slot 4
```

---

## Initial Hack: Hidden Properties

The first idea was:

```typescript
Object.defineProperty(
    tuple,
    "__rid__",
    {
        value: rid,
        enumerable: false
    }
);
```

This allowed:

```
SeqScan
    |
Filter
    |
Delete
```

to preserve the RID.

---

## Why It Was Bad

Although clever, it violated clean architecture.

Problems:

### Hidden State

A tuple looked like:

```
[1, Alice, 25]
```

but secretly contained:

```
__rid__ = (120,4)
```

---

### Type Safety Issues

TypeScript believed:

```typescript
Tuple = Value[]
```

but runtime contained:

```
Tuple + hidden metadata
```

---

### Future Maintenance Risk

Any operator that copied arrays could accidentally lose the RID.

---

# Final Solution: TupleSlot

We redesigned the operator contract:

```typescript
interface TupleSlot {
    tuple: Tuple;
    rid?: RID;
}
```

Now the data is explicit:

```
TupleSlot
{
    tuple:
        [1, Alice, 25],

    rid:
        (120,4)
}
```

---

# Why This Was the Correct Design

It cleanly separates:

```
Logical Data
       |
     Tuple


Physical Location
       |
      RID
```

This is very similar to how production databases maintain tuple metadata.

---

# 3. Expression Evaluation

Queries contain expressions:

```sql
WHERE age > 18
```

or:

```sql
price * quantity > 100
```

MiniDB implemented a recursive expression evaluator.

---

# Why Not Use JavaScript eval?

A naive approach:

```javascript
eval("age > 18")
```

would be dangerous.

Problems:

* Security risks.
* No type safety.
* Hard to optimize.
* Depends on JavaScript runtime semantics.

---

# Evaluator Architecture

Expressions become a tree.

Example:

```
age > 18
```

is represented as:

```
      >
     / \
   age  18
```

Evaluation proceeds recursively:

```
evaluate(>)
     |
     +-- evaluate(age)
     |
     +-- evaluate(18)
     |
     compare values
```

---

Supported operations:

* Arithmetic
* Comparisons
* Boolean logic
* Literals
* Column references

---

# 4. Sequential Scan Operator

The simplest operator:

```
SeqScanOp
```

Its job:

```
Heap File
     |
Read pages
     |
Decode tuples
     |
Return TupleSlots
```

---

## Integration with Transactions

A scan is not only reading memory.

It must respect isolation.

Before returning a tuple:

```
Acquire S Lock
        |
Read tuple
        |
Return TupleSlot
```

Example:

```
T1:
SELECT * FROM users WHERE id=5

gets:

S Lock on RID(10,2)
```

---

# 5. Index Scan Operator

The optimizer may choose:

```
IndexScanOp
```

instead of:

```
SeqScanOp
```

The flow is:

```
Predicate

id = 5000
     |
     v
B+ Tree Search
     |
     v
RID
     |
     v
Heap Fetch
     |
     v
Tuple
```

---

## The Large Scale Verification

A very important milestone occurred during final validation.

Small tables always used:

```
SeqScan
```

even when indexes existed.

The reason was not an execution problem.

The optimizer lacked statistics.

After fixing `ANALYZE`, a 100,000 row test showed:

```
Optimizer:

SeqScan Cost: 100

Index Cost: 4

Decision:
Use IndexScan
```

The final plan:

```
phys_project
      |
phys_filter
      |
phys_index_scan
```

---

# 6. Data Modification Operators

## InsertOp

Insert is much more complicated than:

```
append tuple
```

The correct order is critical.

---

## WAL Rule

The operation sequence is:

```
Generate Log Record
        |
Assign LSN
        |
Modify Page
        |
Set PageLSN
```

This guarantees recovery can replay changes.

---

## Insert Flow

```
Tuple
 |
Heap Insert
 |
RID Generated
 |
Acquire X Lock
 |
Update B+ Tree indexes
 |
Return affected rows
```

---

# Delete Operation

Delete receives:

```
TupleSlot
```

containing:

```
Tuple + RID
```

Flow:

```
Acquire X Lock
        |
Write DELETE WAL record
        |
Remove tuple from Heap
        |
Remove index entries
```

---

# 7. Nested Loop Join

MiniDB implements a tuple nested loop join.

Algorithm:

```
for each outer tuple:

    rewind inner table

    for each inner tuple:

        if condition matches:
            emit joined tuple
```

---

Example:

```
Users
-----
1 Alice
2 Bob


Orders
------
1 Laptop
1 Phone
```

Execution:

```
Alice
 |
 +-- Laptop
 |
 +-- Phone

Bob
 |
 +-- no matches
```

---

# 8. The Volcano Performance Problem

The Volcano model is elegant.

However, it has a fundamental CPU bottleneck.

---

## Imagine Scanning 1 Million Rows

The call pattern becomes:

```
Project.next()

Filter.next()

SeqScan.next()

return one row
```

This happens:

```
1,000,000 times
```

The CPU spends a significant amount of time on:

* Function calls.
* Promise/await overhead.
* Virtual dispatch.
* Branch prediction failures.
* Poor cache locality.

The storage layer may be fast, but the CPU becomes the bottleneck.

---

# The Motivation for Vectorization

The key insight:

> Modern CPUs are optimized to process arrays of values, not individual objects.

Instead of:

```
Row 1
Row 2
Row 3
...
```

process:

```
Batch of 1024 rows
```

---

# 9. The DataChunk Design

MiniDB introduced:

```
DataChunk
```

A fixed-size batch:

```
BATCH_SIZE = 1024
```

---

Instead of storing:

```
[
 [1, Alice, 25],
 [2, Bob, 30],
 [3, Carol, 35]
]
```

we store columns:

```
ID Column:

[1,2,3]


Age Column:

[25,30,35]


Name Buffer:

AliceBobCarol
```

---

# Why Columnar Layout Helps

The CPU can process:

```
age > 18
```

as:

```
for i = 0 to 1024:
    compare age[i]
```

which benefits from:

* Better cache locality.
* JIT optimization.
* SIMD-style instructions.

---

# End of Part 4

Next:

# Part 5 — Vectorized Engine Evolution, Performance Debugging Journey, Benchmarks, LRU-K, Buffer Pool Benchmarks, and the Real Engineering Lessons

Topics covered next:

* The first failed vectorized implementation and why it was slow
* Async iterator bottleneck discovered during benchmarking
* Direct 4KB page decoding optimization
* Eliminating tuple allocations
* Branchless `selectionVector` filtering
* Why Strict 2PL limited speedups (Amdahl’s Law)
* B+ Tree vs SeqScan benchmark journey
* Cache warmup benchmarks
* LRU vs LRU-K analysis
* Final performance numbers and viva defense answers


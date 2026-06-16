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

# B+ Tree Indexing: From Linear Scans to Logarithmic Search

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
# SQL Layer, Query Planning & Cost-Based Optimization

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

# Execution Engine Evolution: Volcano Model, Vectorization, Performance Bottlenecks & Engineering Decisions

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

# Vectorized Engine Evolution, Performance Debugging Journey, Benchmarks & Engineering Lessons

---

# Chapter 5: The Performance Journey — From Theory to Reality

By the end of Phase 7, MiniDB was already a complete relational database engine:

* Heap Storage
* B+ Tree indexing
* Cost-Based Optimizer
* Volcano execution
* Strict 2PL transactions
* ARIES-lite recovery

Functionally, the system was complete.

However, modern analytical databases such as DuckDB, Vectorwise, and modern PostgreSQL extensions have demonstrated that **how queries are executed can be just as important as what algorithm is used**.

A theoretically optimal query plan can still waste enormous CPU time due to execution overhead.

This became the motivation for our extension track:

> **Track A: High-Performance Vectorized Query Execution**

---

# 1. The Original Hypothesis

The classical Volcano model executes:

```
next()
   |
returns 1 tuple
   |
next()
   |
returns 1 tuple
```

For a scan over 1 million rows:

```
1,000,000 next() calls
```

Each call introduces:

* Function call overhead
* Promise scheduling overhead
* JavaScript object allocations
* Tuple array creation
* Poor CPU cache locality

The CPU spends a significant amount of time managing execution machinery rather than evaluating the actual query.

---

# The Goal of Vectorization

Instead of:

```
Row 1:
[1, Alice, 20]

Row 2:
[2, Bob, 30]

Row 3:
[3, Carol, 40]
```

Process:

```
Batch of 1024 rows


ID:
[1,2,3,4,...]


AGE:
[20,30,40,50,...]


NAME:
AliceBobCarol...
```

The database now performs:

```
for i = 0 to 1024:
    age[i] > 18
```

instead of:

```
get next tuple
extract column
compare value
return tuple
repeat
```

The CPU can optimize this pattern far better.

---

# 2. DataChunk Design

The foundation of vectorization is the `DataChunk`.

A DataChunk represents a fixed-size batch:

```
BATCH_SIZE = 1024 rows
```

---

## Primitive Column Storage

Numeric values are stored using TypedArrays:

```
INT       -> Int32Array
BIGINT    -> BigInt64Array
FLOAT     -> Float64Array
BOOLEAN   -> Uint8Array
```

This gives:

* Contiguous memory layout
* Minimal allocation overhead
* Better CPU cache utilization

---

## NULL Handling

A major design decision was:

> How do we represent NULL values when TypedArrays cannot store null?

Our solution:

```
nullBitmap per column
```

Example:

```
Age Values:

[25, 0, 40, 0]


NULL Bitmap:

[0, 1, 0, 1]
```

Meaning:

```
25
NULL
40
NULL
```

This avoids:

* JavaScript boxed objects
* Expensive nullable wrappers
* Branch-heavy null checks

---

## VARCHAR Storage

Strings are more complex.

A naive design:

```
string[]
```

would create thousands of JavaScript objects.

Instead we adopted a columnar string buffer:

```
Offsets:
[0, 5, 8]


Data Buffer:

AliceBobTom
```

The lookup:

```
Row 0:
start = 0
end = 5

=> Alice
```

This approach is similar to Apache Arrow and modern column stores.

---

# 3. Vectorized Operator Architecture

A new execution interface was introduced:

```typescript
interface IVecOperator {
    open(): Promise<void>;
    nextBatch(): Promise<DataChunk | null>;
    close(): Promise<void>;
}
```

The pipeline became:

```
VecProject
      |
VecFilter
      |
VecSeqScan
```

instead of:

```
Project
   |
Filter
   |
SeqScan
```

---

# 4. The First Implementation Failure

Initially, we expected large speedups.

The first implementation simply wrapped the existing heap iterator:

```
HeapFile.scan()
      |
await next()
      |
create tuple
      |
copy into DataChunk
```

Conceptually it was vectorized.

In reality, it was not.

---

## Hidden Bottleneck: Async Iterator Overhead

Every tuple required:

```
await iterator.next()
```

For:

```
1,000,000 rows
```

we still executed:

```
1,000,000 await operations
```

The event loop overhead completely destroyed the expected gains.

This was a major engineering lesson:

> Simply batching the API does not mean the internal execution is vectorized.

---

# 5. Major Optimization: Direct Page Decoding

The solution was to bypass tuple-level iteration.

Instead of:

```
Disk Page
    |
Deserialize Tuple
    |
Create JavaScript Array
    |
Copy into DataChunk
```

we changed the path to:

```
Disk Page
    |
Read raw bytes
    |
Decode directly
    |
Write into TypedArray columns
```

---

## Before

```
Page

 |
Tuple Object

 |
[1, "Alice", 20]

 |
DataChunk
```

Multiple allocations occurred for every row.

---

## After

```
Page Buffer

        |

Column Arrays

ID:
[1,2,3]

AGE:
[20,30,40]
```

Zero intermediate tuple objects.

---

# Result

Benefits:

* Fewer garbage collections
* Lower memory pressure
* Better cache locality
* Much tighter CPU loops

---

# 6. Optimizing VecFilter

The first filter looked like:

```typescript
if (selectionVector[i] === 1) {
    if (age[i] > 18)
        keep row;
}
```

This introduces branching.

Modern CPUs suffer when branch prediction fails.

---

## Branchless Version

We changed it to:

```typescript
selectionVector[i] &= age[i] > 18 ? 1 : 0;
```

Now the CPU executes a predictable tight loop:

```
for i = 0 to 1024:
    selection[i] &= predicate(i)
```

Benefits:

* Fewer branches
* Better JIT optimization
* SIMD-friendly code generation

---

# 7. The Unexpected Limitation — Strict 2PL

After all optimizations, we expected:

```
5x - 10x speedups
```

But real measurements were much lower.

Why?

---

## The Real Bottleneck Was Locking

MiniDB uses row-level Strict 2PL.

Every scan performs:

```
Read Tuple

      |

Acquire Shared Lock

      |

Return Data
```

For 250,000 rows:

```
250,000 lock acquisitions
```

Both:

```
Volcano
```

and

```
Vectorized
```

pay this cost.

---

## Amdahl's Law in Action

Suppose:

```
Execution work:
20 ms

Locking:
350 ms
```

Even if vectorization makes execution:

```
20 ms -> 2 ms
```

Total becomes:

```
Before:
370 ms


After:
352 ms
```

The improvement is small.

---

# Engineering Lesson

The bottleneck moved.

Originally:

```
CPU execution overhead
```

After optimization:

```
Concurrency overhead
```

This is exactly what happens in production systems.

Optimization exposes the next bottleneck.

---

# 8. Benchmark Results

## Initial Measurements

Without removing the iterator bottleneck:

```
Vectorized ≈ Volcano
```

The architecture change existed, but the implementation was inefficient.

---

## After Direct Page Decoding

Performance improved:

```
10,000 rows:
1.26x faster


50,000 rows:
1.82x faster


250,000 rows:
1.27x faster
```

---

## Final Benchmark Configuration

For the release benchmark suite:

```
10,000 rows
50,000 rows
100,000 rows
```

This avoided extremely long benchmark times while clearly demonstrating scaling behavior.

---

# 9. Benchmark Engineering Challenges

While creating the final benchmark suite, several practical issues appeared.

---

## Problem 1: 1 Million Row Benchmark

Originally:

```
1,000,000 rows
```

were tested.

The problem was not the database algorithm.

The benchmark became dominated by:

* Millions of insert operations
* B+ Tree maintenance
* WAL generation
* Lock acquisition

The benchmark ran for several minutes.

---

## Solution

Reduce benchmark sizes to:

```
10K
50K
100K
```

This still demonstrates:

* O(N) sequential scans
* O(log N) index lookups
* Vectorization benefits

while keeping execution under a few minutes.

---

## Problem 2: File Handle Leaks

Early benchmarks directly created:

```
DiskManager
LogManager
BufferPool
```

and occasionally forgot cleanup.

Node.js warned:

```
Closing FileHandle on garbage collection is deprecated
```

---

## Final Solution

All benchmarks were refactored to use:

```typescript
const db = new MiniDB();
```

and:

```typescript
try {
    run benchmark
}
finally {
    await db.close();
}
```

which guarantees:

* WAL flush
* Buffer flush
* Deadlock detector shutdown
* File handle closure

---

# 10. Final Lessons from Vectorization

The vectorized engine became one of the most educational components of MiniDB.

The key lessons were:

---

## Lesson 1

Architecture alone does not create performance.

A vector API built on a row-by-row implementation still behaves like a row engine.

---

## Lesson 2

Memory layout matters.

```
Object Arrays
      ↓
Typed Arrays
```

dramatically improve CPU efficiency.

---

## Lesson 3

Optimizing one subsystem reveals the next bottleneck.

```
Volcano overhead
       ↓
Fixed
       ↓
Lock overhead dominates
```

---

## Lesson 4

Benchmarking is an engineering discipline.

Microbenchmarks can lie.

A realistic benchmark must include:

* I/O
* Locks
* Logging
* Memory allocation
* Index maintenance

---

# Final Viva Defense Statement

> We did not simply implement a vectorized API. During benchmarking we discovered that our initial design still suffered from tuple-level asynchronous overhead. We redesigned the scan path to decode 4KB pages directly into typed column vectors, removed intermediate tuple allocations, and optimized filter execution using branchless selection vectors. The final performance demonstrated meaningful speedups, while also revealing that strict row-level 2PL became the dominant bottleneck, illustrating Amdahl's Law and the trade-offs real database systems face.

---


# Benchmark Validation, Major Bugs, Production Audit, Engineering Trade-offs & Final Lessons

---

# Chapter 6: The Difference Between a Working Database and a Correct Database

By the end of implementation, MiniDB could:

* Execute SQL queries.
* Store tuples.
* Use B+ Tree indexes.
* Run transactions.
* Recover from crashes.
* Execute vectorized analytical queries.

At first glance, the system appeared complete.

However, database systems are among the most correctness-sensitive pieces of software ever written.

A normal application bug might cause:

```
User sees an incorrect webpage.
```

A database bug can cause:

```
Silent corruption of data written months ago.
```

The most important engineering phase of MiniDB was therefore not writing features.

It was **proving that the features were actually correct.**

We conducted a complete Red Team style production audit involving:

* Stress testing.
* Crash simulations.
* Fuzz testing.
* Invariant checking.
* Code review.
* Benchmark validation.

This phase discovered some of the most interesting bugs of the entire project.

---

# 1. Cost-Based Optimizer Validation Journey

---

## The Initial Problem

During early demonstrations:

```sql
CREATE TABLE users(id INT, age INT);

CREATE INDEX idx_id ON users(id);

SELECT * FROM users WHERE id = 2;
```

The query worked.

However:

```sql
EXPLAIN SELECT * FROM users WHERE id = 2;
```

showed:

```
phys_seq_scan
```

instead of:

```
phys_index_scan
```

This looked like an optimizer failure.

---

# Root Cause #1: Small Tables Should Not Use Indexes

Initially, the table contained only:

```
3 rows
```

The cost model correctly estimated:

```
Sequential Scan Cost ≈ 1
Index Scan Cost > 1
```

Therefore:

```
SeqScan wins.
```

This was actually the expected behavior.

---

# Root Cause #2: Missing Statistics

When testing with larger datasets, another issue appeared.

Even with:

```
10000 rows
```

the optimizer sometimes still chose a sequential scan.

The reason:

```
ANALYZE
```

was only recording:

```
rowCount
```

but not column-level statistics.

---

## Original Problem

The catalog contained:

```json
{
  "rowCount": 10000,
  "columnStats": {}
}
```

Therefore the optimizer did not know:

* Minimum value.
* Maximum value.
* Number of distinct values.

The selectivity estimation fell back to defaults:

```
Selectivity = 10%
```

---

# The Fix

ANALYZE was upgraded to scan the entire table and compute:

```
ColumnStats
{
    min,
    max,
    nDistinct
}
```

Example:

```
id column:
min = 1
max = 10000
nDistinct = 10000
```

Now:

```
WHERE id = 9999
```

was estimated as:

```
Selectivity = 1 / nDistinct

= 1 / 10000

= 0.0001
```

---

# Final Optimizer Decision

The cost model compared:

```
SeqScan Cost:
100

Index Cost:
4
```

Result:

```
IndexScan selected.
```

Final plan:

```
phys_project
      |
phys_filter
      |
phys_index_scan
```

---

# Final Performance Result

```
Dataset:
100000 rows

Query:
SELECT * FROM users WHERE id = 50000


Sequential Scan:
≈ 164 ms


B+ Tree Lookup:
≈ 0.03 ms


Speedup:
≈ 5000x
```

---

# 2. The Hidden B+ Tree Root Persistence Bug

---

## The Discovery

One of the most dangerous bugs discovered during the audit involved B+ Tree root splitting.

Initially:

```
Catalog.json

index_root = Page 1
```

The B+ Tree grows:

```
Insert more keys
       |
Leaf splits
       |
Root splits
       |
New root created
```

Internally:

```
BPlusTree._rootPageId
```

was updated.

However:

```
Catalog.json
```

still pointed to the old root.

---

# Why This Was Catastrophic

Before restart:

```
Memory:

root = Page 5
```

Everything worked.

After restarting:

```
Catalog loads:

root = Page 1
```

The database would begin searching from a stale node.

Result:

```
Index corruption.
Lost access paths.
Incorrect query results.
```

---

# The Architectural Fix

A naive solution would have been:

```
BPlusTree → Catalog dependency
```

This would create circular coupling.

Instead we introduced:

```
onRootChange callback
```

Architecture:

```
BPlusTree
      |
      | callback
      v
Catalog.updateIndexRoot()
      |
      v
catalog.json
```

Now every root change is immediately persisted.

---

# Regression Test

A dedicated test inserted:

```
1000 keys
```

forcing multiple root splits.

Then:

```
Shutdown database.
Restart database.
Reload catalog.
Search all keys.
```

Result:

```
1000 / 1000 keys found successfully.
```

---

# 3. The Heap vs B+ Tree Page Corruption Bug

---

## Original Storage Design

MiniDB stores:

```
Heap Pages

and

B+ Tree Pages
```

inside the same physical database file:

```
minidb.db
```

---

## The Bug

Heap scans assumed:

```
Every page is a tuple page.
```

During:

```
ANALYZE users
```

the scanner encountered:

```
B+ Tree internal node page
```

and attempted:

```
deserializeTuple(random bytes)
```

Result:

```
Out-of-bounds reads.
Corrupted tuple decoding.
Crashes.
```

---

# The Fix

The page header was extended with:

```
PageType
```

Example:

```
0 = Heap Page

1 = B+ Tree Leaf

2 = B+ Tree Internal
```

Now scans perform:

```
Read page header

       |
       |
Is Heap?
       |
      Yes
       |
Deserialize tuples


No
 |
Skip page
```

---

# 4. The ARIES Undo LSN Corruption Bug

---

## The Crash

During recovery tests:

```
ERR_OUT_OF_RANGE
```

appeared while reading the WAL.

The parser attempted:

```
beforeLength = 4 million bytes
```

even though the WAL was only around:

```
1 MB
```

---

# Investigation

The issue was in the Undo pass.

The invalid LSN marker was:

```
-1
```

However the stopping condition checked:

```
LSN == 0
```

Therefore:

```
-1
```

was treated as a valid log position.

---

## What Happened Next

Node.js:

```
read(fd, buffer, offset, length, position=-1)
```

does not mean:

```
read before the file
```

Instead it means:

```
Use current file cursor.
```

The recovery engine read:

```
Random bytes
```

from the middle of the WAL.

The decoder interpreted garbage as:

```
Huge beforeImage length
```

causing:

```
ERR_OUT_OF_RANGE
```

---

# The Fix

The Undo stopping condition became:

```
if LSN == INVALID_LSN (-1)
    stop.
```

---

# Validation

Crash test:

```
T1:
Insert 10000 rows
COMMIT


T2:
Delete 500 rows
NO COMMIT


CRASH
```

After recovery:

```
Rows remaining:
10000
```

All committed data survived.

All uncommitted deletes were undone.

---

# 5. Page Header Metadata Corruption Bug

Another subtle storage bug appeared.

Initially:

```
PageLSN
```

was being written using a hardcoded byte offset.

Example:

```
writeBigInt64(offset=16)
```

Unfortunately:

```
Offset 16
```

overlapped with other page metadata.

Result:

```
PageType
Slot Directory
Header fields
```

could be corrupted.

---

# The Fix

The Page class became the single authority for layout.

Instead of:

```
Magic Numbers
```

we introduced:

```
Page.PAGE_LSN_OFFSET

Page.PAGE_TYPE_OFFSET

Page.SLOT_OFFSET
```

Now:

```
BufferPool
      |
      |
Page API
      |
      |
Binary Layout
```

All metadata modifications go through one consistent interface.

---

# 6. Crash Matrix Testing

Normal unit tests prove:

```
Code works when everything goes right.
```

Databases must prove:

```
Data survives when everything goes wrong.
```

---

We built destructive crash scenarios.

---

## Scenario A

Crash after:

```
INSERT
```

but before:

```
COMMIT
```

Result:

```
Tuple disappears.
```

---

## Scenario B

Crash after:

```
WAL flush
```

but before:

```
Page flush
```

Result:

```
Redo restores tuple.
```

---

## Scenario C

Crash after:

```
COMMIT record persisted
```

but before:

```
Client acknowledgement.
```

Result:

```
Transaction survives.
```

---

## Scenario D

Repeated recovery.

```
Recover()
Recover()
Recover()
```

Result:

```
No duplicate rows.
```

Because:

```
pageLSN < logLSN
```

prevents applying the same operation twice.

---

# 7. Concurrency Stress Testing

---

## Deadlock Scenario

```
T1:
Lock A
Wait B


T2:
Lock B
Wait A
```

Wait-for graph:

```
T1 → T2
↑     ↓
└─────┘
```

---

## Detection

The background detector:

```
Runs every interval
       |
Builds Wait-for Graph
       |
DFS cycle detection
       |
Abort youngest transaction
```

---

## Result

The cycle is broken automatically.

No transaction waits forever.

---

# 8. SQL Fuzz Testing

Unit tests are predictable.

Real users are not.

A random workload generator executed:

```
1000 random operations:
```

including:

```
INSERT

DELETE

SELECT
```

MiniDB state was compared against:

```
JavaScript reference Map
```

---

Result:

```
All states matched.
```

No:

* Lost tuples.
* Duplicate records.
* Index inconsistencies.

---

# 9. Final Benchmark Suite

The final release benchmark suite covered the entire system.

---

## B+ Tree vs Sequential Scan

Demonstrated:

```
O(log N)
vs
O(N)
```

Performance:

```
100000 rows

SeqScan:
≈ 164 ms

B+ Tree:
≈ 0.03 ms

≈ 5000x speedup
```

---

## Buffer Pool Cold vs Warm Cache

Cold:

```
Disk Reads
High latency
```

Warm:

```
Memory Hits
Near-zero I/O
```

Demonstrated the value of caching.

---

## LRU-K Benchmark

Compared:

```
Traditional LRU
```

against:

```
LRU-K
```

under workloads mixing:

```
Hot index pages
+
Large sequential scans
```

Result:

```
LRU-K preserved frequently accessed pages
and avoided cache pollution.
```

---

## Vectorized Execution

Demonstrated:

```
~2x speedup
```

through:

* DataChunk batching.
* Typed arrays.
* Branchless filtering.
* Reduced interpretation overhead.

---

# 10. Final Production Audit Verdict

After:

* Crash matrix testing.
* Deadlock testing.
* Fuzzing.
* Benchmarking.
* Manual code review.

The final audit reported:

```
Critical Issues:
0


High Severity:
0


Medium:
2


Low:
5
```

---

# Accepted Design Limitations

---

## No MVCC

MiniDB uses:

```
Strict 2PL
```

Therefore:

```
Readers block writers.
Writers block readers.
```

The benefit:

```
Simple, deterministic serializability.
```

The tradeoff:

```
Lower concurrency.
```

---

## Catalog Not WAL Protected

DDL metadata is stored in:

```
catalog.json
```

A crash during catalog modification can theoretically cause metadata inconsistency.

Production databases store catalog changes inside the WAL.

---

## Manual Pin/Unpin

Pages require explicit:

```
fetchPage()

unpinPage()
```

Future versions would use RAII-style guards to guarantee cleanup.

---

# Final Engineering Lessons

The biggest lesson from MiniDB was that database engineering is not simply implementing algorithms.

Every subsystem interacts:

```
Optimizer
    ↓
Execution
    ↓
Lock Manager
    ↓
Buffer Pool
    ↓
Storage
    ↓
WAL
    ↓
Recovery
```

A small mistake at any layer can corrupt the entire database.

---

# Final Closing Statement

> MiniDB was designed not only as a feature-complete relational database but as an exploration of real database engineering tradeoffs. We implemented a complete path from SQL parsing to physical storage, including a cost-based optimizer, Volcano and vectorized execution engines, Strict 2PL concurrency control, ARIES-style crash recovery, and an LRU-K buffer manager. More importantly, the final stages focused on correctness through crash simulation, fuzz testing, and invariant audits, where several deep storage and recovery bugs were discovered and resolved. The project demonstrates not just how databases work when everything is correct, but how they maintain correctness when everything fails.

---
# End of MiniDB Engineering Journey
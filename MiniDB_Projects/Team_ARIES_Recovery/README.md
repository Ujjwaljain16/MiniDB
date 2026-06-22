
# MiniDB: A Relational Database Engine from Scratch

## Team Information

**Team Name:** Team_ARIES_Recovery

**Members:**

* [Ujjwal Jain] — [ujjwal.24bcs10173@sst.scaler.com] — Roll No: [10173]
* [Ayaan Singh] — [ayaan.24bcs10659@sst.scaler.com] — Roll No: [10659]
* [Rudray Mehra] — [rudray.24bcs10760@sst.scaler.com] — Roll No: [10760]


---

# 1. Project Overview

MiniDB is a custom relational database engine implemented from first principles in TypeScript. The project explores the complete lifecycle of a database query, from SQL parsing and optimization to physical execution, storage management, concurrency control, and crash recovery.

MiniDB implements the core architectural ideas behind modern relational systems including:

* Slotted-page heap storage
* Disk-backed B+ Tree indexing
* LRU-K buffer pool management
* Cost-based query optimization
* Volcano iterator execution model
* Vectorized batch execution
* Strict Two-Phase Locking (2PL)
* Write-Ahead Logging (WAL)
* ARIES-lite crash recovery

**Chosen Extension Track:**
Track A — Performance: Vectorized Execution Engine.

---

# 2. System Architecture

MiniDB follows a layered database architecture:

```
                SQL Query
                    |
                    v
              SQL Parser
                    |
                    v
                 Binder
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
          Volcano / Vector Engine
                    |
                    v
          Transaction & Lock Manager
                    |
                    v
              Buffer Pool (LRU-K)
                    |
                    v
       Heap Storage + B+ Tree Pages
                    |
                    v
              Disk Manager
                    |
                    v
          Write Ahead Log (WAL)
```

The system also includes a background deadlock detector and a recovery manager that executes the ARIES Analysis, Redo, and Undo phases during startup.

---

# 3. Storage Engine

## Page Architecture

MiniDB stores all data inside fixed-size 4KB pages.

Each page contains:

* Static page metadata
* PageLSN for recovery
* Slot directory
* Variable-sized tuple region

The slotted-page design provides stable Record Identifiers (RID):

```
RID = (pageId, slotId)
```

which remain valid even as tuples move inside a page.

---

## Heap File

Tables are stored as collections of heap pages.

Features:

* Sequential table scans
* Dynamic tuple insertion
* Logical tuple deletion
* Free-space management

---

## Buffer Pool

MiniDB implements a buffer manager with:

* LRU-K replacement policy (K=2)
* Page pin/unpin tracking
* Dirty page tracking
* WAL-before-page flush enforcement

Before any dirty page reaches disk, the buffer manager guarantees:

```
WAL LSN >= PageLSN
```

ensuring recovery can always replay the required modifications.

---

# 4. B+ Tree Indexing

MiniDB implements an unclustered disk-backed B+ Tree.

Supported operations:

* Point lookup
* Insert
* Delete
* Node split
* Node merge
* Borrowing from siblings
* Root growth and shrinking

Important implementation details:

* Internal and leaf nodes are stored inside regular 4KB pages.
* Leaf pages maintain sibling pointers for ordered traversal.
* Root page changes are persisted into the catalog through a root-change callback, ensuring index consistency across database restarts.

---

# 5. SQL Processing & Query Execution

## SQL Frontend

MiniDB supports:

* CREATE TABLE
* CREATE INDEX
* INSERT
* DELETE
* SELECT
* WHERE predicates
* Basic JOIN queries
* ANALYZE
* EXPLAIN / EXPLAIN ANALYZE

The SQL parser generates an AST, which is validated and transformed by the Binder into a logical query plan.

---

## Volcano Execution Engine

The row-oriented execution engine follows the iterator model:

```
open()
next()
close()
```

Implemented operators include:

* Sequential Scan
* Index Scan
* Filter
* Projection
* Nested Loop Join
* Insert
* Delete

Execution is fully integrated with:

* Row-level locking
* WAL generation
* Buffer pool management

---

# 6. Cost-Based Optimizer

MiniDB contains a lightweight cost-based optimizer.

The optimizer maintains statistics generated through:

```sql
ANALYZE table_name;
```

Statistics include:

* Row count
* Minimum value
* Maximum value
* Number of distinct values

These statistics are used for:

* Predicate selectivity estimation
* Cardinality estimation
* Sequential scan versus index scan selection
* Join ordering

The optimizer automatically selects an index scan when an available index has a lower estimated cost than a full table scan.

---

# 7. Transactions & Concurrency Control

MiniDB guarantees serializable execution through Strict Two-Phase Locking.

Implemented components:

## Lock Manager

Supports:

* Shared (S) locks
* Exclusive (X) locks
* FIFO waiting queues
* Safe S → X lock upgrades

All locks are released only during:

* COMMIT
* ABORT

ensuring Strict 2PL.

---

## Deadlock Detection

A background detector periodically constructs a wait-for graph.

Example:

```
T1 → T2
↑     ↓
T4 ← T3
```

When a cycle is detected, the youngest transaction is selected as the victim and aborted.

---

# 8. Write-Ahead Logging & Recovery

MiniDB implements an ARIES-inspired recovery subsystem.

## WAL Records

The log records include:

* BEGIN
* COMMIT
* ABORT
* INSERT
* DELETE
* CHECKPOINT

Each record contains:

* LSN
* Previous LSN
* Transaction ID
* Before image
* After image

---

## Recovery Algorithm

During startup, MiniDB executes:

### Analysis Phase

Reconstructs:

* Active Transaction Table
* Dirty Page Table

---

### Redo Phase

Repeats history beginning from the smallest `recLSN`.

The PageLSN check guarantees redo idempotency.

---

### Undo Phase

Traverses loser transactions backwards through `prevLSN` pointers and reverses uncommitted modifications.

For educational simplicity, compensation log records (CLRs) are not implemented.

---

# 9. Extension Track A: Vectorized Execution

Traditional Volcano execution processes one tuple at a time.

MiniDB introduces a vectorized execution engine based on batches:

```
DataChunk (1024 rows)
        |
        |
Typed Arrays
```

Implemented vector operators:

* VecSeqScan
* VecFilter
* VecProject

The vectorized engine:

* Reduces iterator overhead
* Improves CPU cache locality
* Processes column values in tight loops over contiguous memory

---

# 10. Benchmark Results

## B+ Tree vs Sequential Scan

100,000 row point lookup:

```
Query:
SELECT * FROM users WHERE id = 50000

SeqScan: 172.33 ms
B+ Tree: 0.03 ms

Observed speedup: ~4985x
```

---

## Volcano vs Vectorized Execution

Large scan filtering workload:

```
Volcano:    24.86 ms
Vectorized: 11.39 ms

Speedup: ~2.18x
```

---

## Buffer Pool Caching

Cold versus warm cache:

```
Cold cache:
Latency: 34.95 ms
Hit rate: 0%

Warm cache:
Latency: 20.62 ms
Hit rate: 100%
```

These benchmarks demonstrate the impact of indexing, caching, and vectorized execution on database performance.

---

# 11. Known Limitations

MiniDB intentionally makes several tradeoffs to keep the system educational.

## No MVCC

The system uses Strict 2PL instead of multi-version concurrency control.

As a result:

* Readers can block writers
* Writers can block readers

---

## Catalog Metadata Is Not WAL Protected

Schema and index metadata are stored in `catalog.json`.

A crash during DDL persistence could theoretically leave catalog metadata inconsistent with physical storage.

---

## Manual Page Pin Management

The storage layer currently uses explicit:

```
fetchPage()
unpinPage()
```

management rather than automatic scope guards.

The implementation is correct under current tests, but future development requires careful pin balancing.

---

## Index Backfilling

Creating an index on an already populated table does not automatically scan existing tuples to populate the B+ Tree.

The recommended workflow is:

```
CREATE INDEX
      |
INSERT records
```

---

# 12. Running MiniDB

## Install Dependencies

```bash
npm install
```

---

## Run Tests

```bash
npm test
```

---

## Run Benchmark Suite

```bash
npm run bench
```

---

## Start Interactive Shell

```bash
npm run cli
```

---

Example session:

```sql
CREATE TABLE users(id INT, age INT);

INSERT INTO users VALUES(1, 20);
INSERT INTO users VALUES(2, 30);

CREATE INDEX idx_id ON users(id);

ANALYZE users;

EXPLAIN ANALYZE SELECT * FROM users WHERE id = 2;

SHOW ENGINE STATUS;
```

---

# Conclusion

MiniDB demonstrates the complete architecture of a modern relational database system in an educational setting. It integrates storage management, indexing, cost-based optimization, execution engines, transaction management, and ARIES-style recovery into a single cohesive database engine.

While intentionally simplified compared to production systems such as PostgreSQL or SQLite, MiniDB preserves the fundamental algorithms and engineering tradeoffs that power real-world database systems.

// src/recovery/CrashRecovery.ts — Phase 6
// ARIES-lite: analysis → redo → undo.

import type { ILogManager, IBufferPool, ITxnManager, Transaction } from '../common/interfaces.js';
import type { LSN, PageId, TxnId } from '../common/types.js';
import { TxnState } from '../common/interfaces.js';
import { Page } from '../storage/Page.js';
import { CheckpointManager } from './CheckpointManager.js';
import fs from 'fs';
import path from 'path';

export async function recover(
  logManager: ILogManager,
  bufferPool: IBufferPool,
  txnManager: ITxnManager,
  dataDir: string
): Promise<void> {

  const checkpointManager = new CheckpointManager(logManager, bufferPool, txnManager, dataDir);
  const lastCheckpointLsn = await checkpointManager.readLastCheckpoint() || 0 as unknown as LSN;

  // ── ANALYSIS PASS ─────────────────────────────────────────────────────────
  console.log(`[CrashRecovery] Starting Analysis Pass from LSN ${lastCheckpointLsn}`);
  
  // Start with tables from checkpoint, or empty if none
  let activeTxns = new Map<TxnId, Transaction>();
  let dirtyPageTable = new Map<PageId, LSN>();

  if (lastCheckpointLsn > 0) {
    // We need to read the CHECKPOINT record to populate the tables
    // Since checkpoint is fuzzy, the CHECKPOINT record is exactly at lastCheckpointLsn
    // We iterate from it. The first record SHOULD be the CHECKPOINT record.
  }

  let iterator = logManager.iterator(lastCheckpointLsn);
  
  for await (const record of iterator) {
    if (record.type === 'CHECKPOINT') {
      const payload = record.afterImage;
      if (payload) {
        const decoded = checkpointManager.deserializeCheckpoint(payload);
        activeTxns = decoded.activeTxns;
        dirtyPageTable = decoded.dirtyPages;
      }
      continue;
    }

    // Update active transaction table
    if (record.txnId > 0) {
      if (!activeTxns.has(record.txnId)) {
        activeTxns.set(record.txnId, {
          txnId: record.txnId,
          state: TxnState.GROWING,
          beginLsn: record.lsn,
          prevLsn: record.prevLsn,
        });
      }
      const txn = activeTxns.get(record.txnId)!;
      txn.prevLsn = record.lsn; // move the chain forward

      if (record.type === 'COMMIT') {
        txn.state = TxnState.COMMITTED;
      } else if (record.type === 'ABORT') {
        txn.state = TxnState.ABORTED;
      }
    }

    // Update dirty page table
    if (['INSERT', 'UPDATE', 'DELETE'].includes(record.type) && record.rid) {
      const pageId = record.rid.pageId;
      if (!dirtyPageTable.has(pageId)) {
        dirtyPageTable.set(pageId, record.lsn);
      }
    }
  }

  // Determine winners and losers
  const winnerSet = new Set<TxnId>();
  const loserSet = new Set<TxnId>();
  for (const [txnId, txn] of activeTxns.entries()) {
    if (txn.state === TxnState.COMMITTED || txn.state === TxnState.ABORTED) {
      winnerSet.add(txnId);
    } else {
      loserSet.add(txnId);
    }
  }

  console.log(`[CrashRecovery] Analysis complete. Winners: ${winnerSet.size}, Losers: ${loserSet.size}, DirtyPages: ${dirtyPageTable.size}`);

  // ── REDO PASS ─────────────────────────────────────────────────────────────
  // Start from min recLsn
  let redoStartLsn = Number.MAX_SAFE_INTEGER as unknown as LSN;
  for (const recLsn of dirtyPageTable.values()) {
    if (Number(recLsn) < Number(redoStartLsn)) {
      redoStartLsn = recLsn;
    }
  }

  if (dirtyPageTable.size === 0) {
    redoStartLsn = lastCheckpointLsn;
  }

  console.log(`[CrashRecovery] Starting Redo Pass from LSN ${redoStartLsn}`);

  iterator = logManager.iterator(redoStartLsn);
  for await (const record of iterator) {
    if (['INSERT', 'UPDATE', 'DELETE'].includes(record.type) && record.rid) {
      const pageId = record.rid.pageId;
      
      // Repeating history
      const buf = await bufferPool.fetchPage(pageId);
      const page = new Page(buf);

      if (Number(page.pageLsn) < Number(record.lsn)) {
        if (page.freeSpacePtr === 0) {
          // Page was never flushed to disk before crash
          page.init(pageId, pageId === 0 ? 3 : 0);
        }

        if (record.type === 'INSERT' && record.afterImage) {
          page.forceInsertRecord(record.rid.slotId, record.afterImage);
        } else if (record.type === 'DELETE') {
          page.deleteRecord(record.rid.slotId);
        } else if (record.type === 'UPDATE') {
          if (record.afterImage) {
            page.deleteRecord(record.rid.slotId);
            page.forceInsertRecord(record.rid.slotId, record.afterImage);
          }
        }
        page.pageLsn = record.lsn;
        bufferPool.setPageLsn(pageId, record.lsn);
        bufferPool.unpinPage(pageId, true);
      } else {
        bufferPool.unpinPage(pageId, false);
      }
    }
  }

  console.log(`[CrashRecovery] Redo Pass complete.`);

  // ── UNDO PASS ─────────────────────────────────────────────────────────────
  console.log(`[CrashRecovery] Starting Undo Pass for ${loserSet.size} losers.`);
  
  // We need to undo all loser records in reverse chronological order
  // For simplicity, we can load all records for the losers into memory and sort by LSN descending.
  // Alternatively, since we know their lastLsn (prevLsn of the transaction),
  // we can repeatedly fetch log records by LSN. 
  // However, `iterator()` only goes forward.
  // Since this is an educational implementation, and memory is fine for the undo queue:
  
  // ARIES does a priority queue of nextLsn.
  const undoQueue: LSN[] = [];
  for (const txnId of loserSet) {
    const txn = activeTxns.get(txnId)!;
    undoQueue.push(txn.prevLsn);
  }

  // Function to fetch a specific record by LSN
  // Because we didn't implement random access `readAt` in LogManager,
  // we'll scan from 0 to collect all loser records.
  // Note: For a real system, LogManager would read directly using LSN = physical offset.
  
  // Wait, I DID implement LSN = physical offset!
  // So I can just read the log file randomly!
  // Let's implement a quick reader here.
  const walPath = path.join(dataDir, 'wal.log');
  let logFileHandle: fs.promises.FileHandle | null = null;
  
  try {
    logFileHandle = await fs.promises.open(walPath, 'r');
    
    // Sort undo queue descending
    undoQueue.sort((a, b) => Number(b) - Number(a));

    while (undoQueue.length > 0) {
      const nextLsn = undoQueue.shift()!;
      if (Number(nextLsn) === -1 || Number(nextLsn) === 0) continue; // -1/0 is invalid/null prevLsn

      // Read record
      // We don't know the size, so we read a chunk
      const chunk = Buffer.alloc(64 * 1024);
      await logFileHandle.read(chunk, 0, chunk.length, Number(nextLsn));
      
      const { decodeLogRecord } = await import('./LogRecord.js');
      const { record } = decodeLogRecord(chunk);

      // Undo the operation
      if (['INSERT', 'UPDATE', 'DELETE'].includes(record.type) && record.rid) {
        const pageId = record.rid.pageId;
        const buf = await bufferPool.fetchPage(pageId);
        const page = new Page(buf);

        if (record.type === 'INSERT') {
          page.deleteRecord(record.rid.slotId);
        } else if (record.type === 'DELETE' && record.beforeImage) {
          if (page.freeSpace() < record.beforeImage.length + 4) {
            page.compact();
          }
          page.forceInsertRecord(record.rid.slotId, record.beforeImage);
        } else if (record.type === 'UPDATE' && record.beforeImage) {
          page.deleteRecord(record.rid.slotId);
          if (page.freeSpace() < record.beforeImage.length + 4) {
            page.compact();
          }
          page.forceInsertRecord(record.rid.slotId, record.beforeImage);
        }

        // We intentionally SKIP Compensation Log Records (CLRs) as documented in the spec.
        
        // Write ABORT record after completing undo for this txn
        // Wait, ABORT is written at the END of the transaction's undo.
        // For now, we'll write it when we hit the BEGIN record, or prevLsn = 0.
        
        // Since we modify the page, we need a new LSN for the pageLsn.
        // We can append an ABORT or just an empty dummy record to advance LSN if we were doing CLRs.
        // Since we don't do CLRs, we just use a generic LogManager append to bump LSN, 
        // but `pageLsn` needs *some* LSN. We can append a dummy or skip updating it (safe because redo is idempotent).
        // Let's just update `pageLsn` by grabbing the current LSN from log manager without writing.
        const newLsn = logManager.currentLsn();
        page.pageLsn = newLsn;
        bufferPool.setPageLsn(pageId, newLsn);
        bufferPool.unpinPage(pageId, true);
      }

      if (Number(record.prevLsn) !== -1 && Number(record.prevLsn) !== 0) {
        undoQueue.push(record.prevLsn);
        undoQueue.sort((a, b) => Number(b) - Number(a));
      } else {
        // We reached the beginning of the transaction, it is fully undone.
        await logManager.append({
          prevLsn: record.lsn,
          txnId: record.txnId,
          type: 'ABORT'
        });
      }
    }
  } finally {
    if (logFileHandle) await logFileHandle.close();
  }

  // Force a checkpoint at the end of recovery to flush all state
  await checkpointManager.writeCheckpoint();

  console.log(`[CrashRecovery] Undo Pass complete. Recovery successful.`);
}

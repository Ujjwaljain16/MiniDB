// src/recovery/CheckpointManager.ts — Phase 6
// Fuzzy checkpoint: write dirty page table + active txn table to WAL.

import { promises as fs } from 'fs';
import path from 'path';
import type { ILogManager, IBufferPool, ITxnManager, Transaction } from '../common/interfaces.js';
import type { LSN, PageId, TxnId } from '../common/types.js';
import { TxnState } from '../common/interfaces.js';

export interface CheckpointData {
  activeTxns: Map<TxnId, Transaction>;
  dirtyPages: Map<PageId, LSN>;
}

export class CheckpointManager {
  private metaPath: string;

  constructor(
    private logManager: ILogManager,
    private bufferPool: IBufferPool,
    private txnManager: ITxnManager,
    dataDir: string
  ) {
    this.metaPath = path.join(dataDir, 'checkpoint.meta');
  }

  async writeCheckpoint(): Promise<void> {
    const activeTxns = this.txnManager.activeTransactions();
    const dirtyPages = this.bufferPool.getDirtyPageTable();

    const payload = this.serializeCheckpoint(activeTxns, dirtyPages);

    const checkpointLsn = await this.logManager.append({
      prevLsn: 0 as unknown as LSN,
      txnId: 0 as TxnId, // System transaction
      type: 'CHECKPOINT',
      afterImage: payload,
    });

    // CRUCIAL: force flush the CHECKPOINT record to disk before updating meta
    await this.logManager.flush(checkpointLsn);

    // Write checkpointLsn to checkpoint.meta
    const metaBuf = Buffer.alloc(8);
    metaBuf.writeBigUInt64LE(BigInt(checkpointLsn), 0);
    
    // Write safely (write to temp then rename)
    const tempMetaPath = `${this.metaPath}.tmp`;
    await fs.writeFile(tempMetaPath, metaBuf);
    await fs.rename(tempMetaPath, this.metaPath);
  }

  async readLastCheckpoint(): Promise<LSN | null> {
    try {
      const buf = await fs.readFile(this.metaPath);
      if (buf.length === 8) {
        return Number(buf.readBigUInt64LE(0)) as unknown as LSN;
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.warn('Failed to read checkpoint.meta:', e.message);
      }
    }
    return null;
  }

  public serializeCheckpoint(activeTxns: ReadonlyMap<TxnId, Transaction>, dirtyPages: Map<PageId, LSN>): Buffer {
    let size = 4; // activeTxns count
    size += activeTxns.size * (4 + 1 + 8); // txnId(4), state(1), prevLsn(8)
    size += 4; // dirtyPages count
    size += dirtyPages.size * (4 + 8); // pageId(4), recLsn(8)

    const buf = Buffer.alloc(size);
    let offset = 0;

    buf.writeUInt32LE(activeTxns.size, offset); offset += 4;
    for (const [txnId, txn] of activeTxns.entries()) {
      buf.writeUInt32LE(txnId, offset); offset += 4;
      
      let stateVal = 0;
      switch (txn.state) {
        case TxnState.GROWING: stateVal = 0; break;
        case TxnState.WAITING: stateVal = 1; break;
        case TxnState.COMMITTED: stateVal = 2; break;
        case TxnState.ABORTED: stateVal = 3; break;
      }
      buf.writeUInt8(stateVal, offset); offset += 1;
      
      buf.writeBigUInt64LE(BigInt(txn.prevLsn), offset); offset += 8;
    }

    buf.writeUInt32LE(dirtyPages.size, offset); offset += 4;
    for (const [pageId, recLsn] of dirtyPages.entries()) {
      buf.writeUInt32LE(pageId, offset); offset += 4;
      buf.writeBigUInt64LE(BigInt(recLsn), offset); offset += 8;
    }

    return buf;
  }

  public deserializeCheckpoint(buf: Buffer): CheckpointData {
    let offset = 0;
    
    const activeTxns = new Map<TxnId, Transaction>();
    const numTxns = buf.readUInt32LE(offset); offset += 4;
    for (let i = 0; i < numTxns; i++) {
      const txnId = buf.readUInt32LE(offset) as TxnId; offset += 4;
      const stateVal = buf.readUInt8(offset); offset += 1;
      
      let state = TxnState.GROWING;
      switch (stateVal) {
        case 0: state = TxnState.GROWING; break;
        case 1: state = TxnState.WAITING; break;
        case 2: state = TxnState.COMMITTED; break;
        case 3: state = TxnState.ABORTED; break;
      }

      const prevLsn = Number(buf.readBigUInt64LE(offset)) as unknown as LSN; offset += 8;

      activeTxns.set(txnId, {
        txnId,
        state,
        beginLsn: 0 as unknown as LSN, // beginLsn is not strict for undo pass
        prevLsn,
      });
    }

    const dirtyPages = new Map<PageId, LSN>();
    const numPages = buf.readUInt32LE(offset); offset += 4;
    for (let i = 0; i < numPages; i++) {
      const pageId = buf.readUInt32LE(offset) as PageId; offset += 4;
      const recLsn = Number(buf.readBigUInt64LE(offset)) as unknown as LSN; offset += 8;
      dirtyPages.set(pageId, recLsn);
    }

    return { activeTxns, dirtyPages };
  }
}

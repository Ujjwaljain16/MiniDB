import type { IVecOperator } from './IVecOperator.js';
import type { DataChunk, PrimitiveTypedArray } from './DataChunk.js';
import { VarcharBuffer } from './DataChunk.js';
import type { PhysFilter } from '../optimizer/PhysicalPlan.js';
import type { ExecContext } from '../common/interfaces.js';
export class VecFilter implements IVecOperator {
  private child!: IVecOperator;

  constructor(private plan: PhysFilter, private buildChild: (node: any) => IVecOperator) {
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    await this.child.open(ctx);
  }

  async nextBatch(): Promise<DataChunk | null> {
    while (true) {
      const chunk = await this.child.nextBatch();
      if (!chunk) return null;

      this.applyPredicate(chunk);

      // Check if any rows survived
      let anySurvived = false;
      for (let i = 0; i < chunk.numRows; i++) {
        if (chunk.selectionVector[i] === 1) {
          anySurvived = true;
          break;
        }
      }

      if (anySurvived) {
        return chunk;
      }
      // If fully filtered, fetch next batch
    }
  }

  private applyPredicate(chunk: DataChunk) {
    const expr = this.plan.predicate;
    
    // Fast path: simple binary expressions (e.g. col = literal)
    if (expr.kind === 'bound_binary') {
      let colIdx = -1;
      let literalVal: any = null;
      let op = expr.op;
      
      // Determine left/right
      if (expr.left.kind === 'bound_col' && expr.right.kind === 'bound_literal') {
        colIdx = expr.left.columnIndex;
        literalVal = expr.right.value;
      } else if (expr.right.kind === 'bound_col' && expr.left.kind === 'bound_literal') {
        colIdx = expr.right.columnIndex;
        literalVal = expr.left.value;
        // Flip operator
        if (op === '>') op = '<';
        else if (op === '<') op = '>';
        else if (op === '>=') op = '<=';
        else if (op === '<=') op = '>=';
      }

      if (colIdx !== -1) {
        const colVec = chunk.columns[colIdx]!;
        const numRows = chunk.numRows;
        const sel: any = chunk.selectionVector;
        const nulls: any = colVec.nullMask;

        if (colVec.values instanceof VarcharBuffer) {
          // Varchar loop (not as fast as primitives but still tight)
          const buffer = colVec.values;
          for (let i = 0; i < numRows; i++) {
            if (sel[i] === 0) continue;
            if (nulls[i] === 1) { sel[i] = 0; continue; }
            const val = buffer.getString(i);
            sel[i] = this.evaluateOp(val, literalVal, op) ? 1 : 0;
          }
        } else {
          // Primitive typed array loop - JIT friendly!
          const values: any = colVec.values;
          
          switch (op) {
            case '=':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! === literalVal) ? 1 : 0;
              }
              break;
            case '>':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! > literalVal) ? 1 : 0;
              }
              break;
            case '<':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! < literalVal) ? 1 : 0;
              }
              break;
            case '>=':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! >= literalVal) ? 1 : 0;
              }
              break;
            case '<=':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! <= literalVal) ? 1 : 0;
              }
              break;
            case '!=':
              for (let i = 0; i < numRows; i++) {
                sel[i] &= (nulls[i] === 0 && values[i]! !== literalVal) ? 1 : 0;
              }
              break;
          }
        }
        return;
      }
    }
    
    // Fallback for complex expressions
    throw new Error('VecFilter: Complex predicates not implemented for benchmarking.');
  }

  private evaluateOp(left: any, right: any, op: string): boolean {
    switch (op) {
      case '=': return left === right;
      case '!=': return left !== right;
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      default: return false;
    }
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}

import type { IVecOperator } from './IVecOperator.js';
import { DataChunk } from './DataChunk.js';
import type { PhysProject } from '../optimizer/PhysicalPlan.js';
import type { ExecContext } from '../common/interfaces.js';

export class VecProject implements IVecOperator {
  private child!: IVecOperator;
  private projectedChunk!: DataChunk;
  private isInitialized = false;

  constructor(private plan: PhysProject, private buildChild: (node: any) => IVecOperator) {
    this.child = this.buildChild(plan.child);
  }

  async open(ctx: ExecContext): Promise<void> {
    await this.child.open(ctx);
  }

  async nextBatch(): Promise<DataChunk | null> {
    const chunk = await this.child.nextBatch();
    if (!chunk) return null;

    if (!this.isInitialized) {
      // Create a new schema based on projections
      // For simplicity in this benchmark, we assume projections are just 'bound_col' expressions
      const newSchema: any = this.plan.projections.map(p => {
        if (p.kind === 'bound_col') {
          return { name: p.columnName, type: p.type, nullable: true };
        }
        throw new Error('VecProject: Complex projections not supported in benchmark.');
      });

      this.projectedChunk = new DataChunk(newSchema);
      this.isInitialized = true;
    }

    // Zero-copy projection: just link the column vectors and selection vector
    this.projectedChunk.numRows = chunk.numRows;
    this.projectedChunk.selectionVector = chunk.selectionVector; // Share the selection vector

    for (let i = 0; i < this.plan.projections.length; i++) {
      const p = this.plan.projections[i]!;
      if (p.kind === 'bound_col') {
        this.projectedChunk.columns[i] = chunk.columns[p.columnIndex]!;
      }
    }

    return this.projectedChunk;
  }

  async close(): Promise<void> {
    await this.child.close();
  }
}

import type { PhysicalNode, PhysNLJ } from './PhysicalPlan.js';
import type { BoundExpression } from '../sql/LogicalPlan.js';
import type { ICatalog } from '../common/interfaces.js';
import { andAll, tablesReferenced } from './Predicates.js';

export interface JoinNode {
  node: PhysicalNode;
  tables: Set<string>;
  estRows: number;
}

export class JoinOrderer {
  constructor(private catalog: ICatalog) {}

  orderJoins(scans: JoinNode[], conditions: BoundExpression[]): PhysicalNode {
    if (scans.length === 0) throw new Error('No scans to join');
    if (scans.length === 1) {
      // If there are conditions left, we should apply them as a filter
      // But typically conditions here are join conditions.
      return scans[0]!.node;
    }
    
    if (scans.length <= 3) {
      return this.orderExhaustive(scans, conditions);
    } else {
      return this.orderGreedy(scans, conditions);
    }
  }

  private orderExhaustive(scans: JoinNode[], conditions: BoundExpression[]): PhysicalNode {
    const permutations = this.getPermutations(scans);
    let bestPlan: PhysicalNode | null = null;
    let bestCost = Infinity;

    for (const perm of permutations) {
      const plan = this.buildLeftDeepTree(perm, conditions);
      if (plan.estCost < bestCost) {
        bestCost = plan.estCost;
        bestPlan = plan;
      }
    }

    return bestPlan!;
  }

  private orderGreedy(scans: JoinNode[], conditions: BoundExpression[]): PhysicalNode {
    // Greedy: always join the pair with the smallest estimated output first (left-deep)
    // Actually, greedy left-deep means we start with the smallest relation, then iteratively 
    // pick the next relation that produces the smallest join result with the current accumulated relation.
    
    let remaining = [...scans];
    
    // Pick the smallest scan to start
    remaining.sort((a, b) => a.estRows - b.estRows);
    let current = remaining.shift()!;

    while (remaining.length > 0) {
      let bestNextIndex = -1;
      let bestNextCost = Infinity;
      let bestNextJoin: JoinNode | null = null;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]!;
        // Temporarily build join to estimate cost
        const tempPlan = this.buildJoin(current, candidate, conditions);
        if (tempPlan.estCost < bestNextCost) {
          bestNextCost = tempPlan.estCost;
          bestNextIndex = i;
          bestNextJoin = {
            node: tempPlan,
            tables: new Set([...current.tables, ...candidate.tables]),
            estRows: tempPlan.estRows
          };
        }
      }

      remaining.splice(bestNextIndex, 1);
      current = bestNextJoin!;
    }

    return current.node;
  }

  private buildLeftDeepTree(scans: JoinNode[], conditions: BoundExpression[]): PhysicalNode {
    let current = scans[0]!;
    for (let i = 1; i < scans.length; i++) {
      const right = scans[i]!;
      const joinedNode = this.buildJoin(current, right, conditions);
      current = {
        node: joinedNode,
        tables: new Set([...current.tables, ...right.tables]),
        estRows: joinedNode.estRows
      };
    }
    return current.node;
  }

  private buildJoin(left: JoinNode, right: JoinNode, conditions: BoundExpression[]): PhysicalNode {
    const applicable = conditions.filter(c => this.isConditionApplicable(c, left.tables, right.tables));

    // Default selectivity for a join with a condition; a cross join keeps every pair.
    const joinSelectivity = applicable.length > 0 ? 0.1 : 1.0;

    const estRows = Math.round(left.estRows * right.estRows * joinSelectivity);
    // Cost of NLJ = left.cost + (left.rows * right.cost)
    // Wait, cost is usually IO cost. 
    // If right is a sequence scan, its cost is right.cost.
    // NLJ cost: outerRows * innerCost
    const estCost = left.node.estCost + (left.estRows * right.node.estCost);

    const nlj: PhysNLJ = {
      kind: 'phys_nlj',
      left: left.node,
      right: right.node,
      condition: applicable.length > 0 ? andAll(applicable) : {
        kind: 'bound_literal',
        value: true,
        type: 'BOOL'
      }, // Cross join if no condition
      estRows,
      estCost
    };

    return nlj;
  }

  /**
   * A condition belongs to the join where all its tables first meet: every
   * table it reads is available, and it reads from both sides. In a left-deep
   * tree that places each multi-table condition at exactly one join.
   */
  private isConditionApplicable(cond: BoundExpression, leftTables: Set<string>, rightTables: Set<string>): boolean {
    const refs = [...tablesReferenced(cond)];
    return refs.every(t => leftTables.has(t) || rightTables.has(t)) &&
      refs.some(t => leftTables.has(t)) &&
      refs.some(t => rightTables.has(t));
  }

  private getPermutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const perms: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of this.getPermutations(rest)) {
        perms.push([arr[i]!, ...p]);
      }
    }
    return perms;
  }
}

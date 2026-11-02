import { describe, it, expect } from 'vitest';
import { diffSnapshots } from './release-diff.js';

describe('diffSnapshots', () => {
  const v1 = [
    { name: 'getOrder', description: 'Get.', effect_classes: ['read_only'], input_schema: { properties: { id: { description: 'Id' } } } },
    { name: 'oldTool', description: 'x' },
  ];
  const v2 = [
    { name: 'getOrder', description: 'Get one order.', eligible_use: 'the user names an order id', effect_classes: ['read_only'],
      input_schema: { properties: { id: { description: 'Order id, e.g. ord_123' } } } },
    { name: 'newTool', description: 'y' },
  ];

  it('reports added, removed and changed tools with field-level before/after', () => {
    expect(diffSnapshots(v1, v2)).toEqual([
      { tool: 'getOrder', change: 'changed', fields: [
        { field: 'description', before: 'Get.', after: 'Get one order.\nUse when: the user names an order id' },
        { field: 'param:id', before: 'Id', after: 'Order id, e.g. ord_123' },
      ] },
      { tool: 'newTool', change: 'added' },
      { tool: 'oldTool', change: 'removed' },
    ]);
  });

  it('is empty for identical releases', () => {
    expect(diffSnapshots(v1, v1)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { can, normaliseRole } from '../services/users';

describe('R6 RBAC role hierarchy', () => {
  it('admin can do everything', () => {
    expect(can('admin', 'viewer')).toBe(true);
    expect(can('admin', 'editor')).toBe(true);
    expect(can('admin', 'admin')).toBe(true);
  });

  it('editor can edit but not admin', () => {
    expect(can('editor', 'viewer')).toBe(true);
    expect(can('editor', 'editor')).toBe(true);
    expect(can('editor', 'admin')).toBe(false);
  });

  it('viewer can only view', () => {
    expect(can('viewer', 'viewer')).toBe(true);
    expect(can('viewer', 'editor')).toBe(false);
    expect(can('viewer', 'admin')).toBe(false);
  });

  it('missing role defaults to admin (backward compat with pre-RBAC installs)', () => {
    expect(normaliseRole(undefined)).toBe('admin');
    expect(can(undefined, 'admin')).toBe(true);
  });
});



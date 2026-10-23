import { describe, expect, it } from 'vitest';
import {
  isLegacyPermissionModeId,
  isPermissionPolicyId,
  isPermissionPresetId,
} from './permission-preset.js';

describe('canonical permission ids', () => {
  it('accepts exactly the V2 presets and legacy policy ids', () => {
    for (const preset of ['read-only', 'workspace-write', 'full-access']) {
      expect(isPermissionPresetId(preset)).toBe(true);
      expect(isPermissionPolicyId(preset)).toBe(false);
    }
    for (const legacy of ['full', 'research', 'restricted']) {
      expect(isPermissionPolicyId(legacy)).toBe(true);
      expect(isLegacyPermissionModeId(legacy)).toBe(true);
      expect(isPermissionPresetId(legacy)).toBe(false);
    }
    expect(isLegacyPermissionModeId('info')).toBe(true);
    expect(isLegacyPermissionModeId('physical')).toBe(true);
    expect(isLegacyPermissionModeId('read-only')).toBe(false);
    expect(isPermissionPresetId('unknown')).toBe(false);
  });
});

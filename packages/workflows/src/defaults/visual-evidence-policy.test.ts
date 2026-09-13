import { describe, expect, it } from 'bun:test';
import { BUNDLED_COMMANDS } from './bundled-defaults';

describe('visual evidence policy', () => {
  it('requires the complete product page and rejects component stand-ins', () => {
    const implement = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:implement::implement'];
    const publish = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:pr::pr'];
    const review = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-code'];
    const synthesize = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize'];

    for (const command of [implement, publish, review, synthesize]) {
      expect(command).toContain('component harness');
      expect(command).toContain('complete product');
    }
    expect(implement).toContain('"version": 2');
    expect(implement).toContain('"runtime_command"');
    expect(implement).toContain('"capture_url"');
    expect(publish).toContain('existing-project `runtime_command`');
  });
});

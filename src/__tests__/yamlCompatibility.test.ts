import { describe, expect, it } from 'vitest';
import { load } from '../utils/yaml';

describe('configuration YAML compatibility', () => {
  it('retains anchor merges and explicit overrides in existing configurations', () => {
    const doc = load(`defaults: &defaults
  image: example/backend:1
  restart: unless-stopped
services:
  backend:
    <<: *defaults
    image: example/backend:2
`) as any;
    expect(doc.services.backend).toEqual({ image: 'example/backend:2', restart: 'unless-stopped' });
  });

  it('retains YAML 1.2 booleans and rejects duplicate keys', () => {
    expect(load('enabled: true\nname: no\n')).toEqual({ enabled: true, name: 'no' });
    expect(() => load('image: one\nimage: two\n')).toThrow();
  });
});

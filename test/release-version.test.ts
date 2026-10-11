import { describe, expect, test } from 'bun:test';
import { parsePushCommit, parseReleaseInput } from '../scripts/release-version.mjs';

describe('release input parser', () => {
  test('maps stable versions to latest', () => {
    expect(parseReleaseInput('1.2.3', '0.9.0')).toEqual({ version: '1.2.3', tag: 'latest' });
  });

  test.each([
    ['1.2.3-dev.1', 'dev'],
    ['1.2.3-next.2', 'next'],
    ['1.2.3-beta.4', 'beta'],
    ['1.2.3-rc.5', 'rc'],
    ['1.2.3-custom-channel.1', 'custom-channel'],
  ])('maps explicit prerelease %s to the %s tag', (version, tag) => {
    expect(parseReleaseInput(version, '1.0.0')).toEqual({ version, tag });
  });

  test('generates a timestamped prerelease from a channel', () => {
    expect(parseReleaseInput('dev', '1.2.3', { timestamp: 1791700000000 })).toEqual({
      version: '1.2.3-dev.1791700000000',
      tag: 'dev',
    });
  });

  test('extracts the stable base from an existing prerelease version', () => {
    expect(parseReleaseInput('next', '1.2.3-rc.1+build.7', { timestamp: 99 })).toEqual({
      version: '1.2.3-next.99',
      tag: 'next',
    });
  });

  test('rejects empty, whitespace, malformed, and shell-like input', () => {
    for (const input of ['', ' dev', '1.2', '1.2.3-', '1.2.3-dev.', '1.2.3-dev.01', '01.2.3', 'dev; touch /tmp/pwn']) {
      expect(() => parseReleaseInput(input, '1.2.3')).toThrow();
    }
  });

  test('rejects uppercase, unsafe, and reserved prerelease tags', () => {
    for (const input of ['1.2.3-DEV.1', '1.2.3-latest.1', '1.2.3-foo_bar.1', 'latest']) {
      expect(() => parseReleaseInput(input, '1.2.3')).toThrow();
    }
  });

  test('rejects channel-only values from push events', () => {
    expect(() => parseReleaseInput('dev', '1.2.3', { trigger: 'push' })).toThrow('workflow_dispatch');
  });

  test('uses only exact supported commit subjects', () => {
    expect(parsePushCommit('1.2.3', '1.0.0')).toEqual({ version: '1.2.3', tag: 'latest' });
    expect(parsePushCommit('1.2.4-dev.1', '1.0.0')).toEqual({ version: '1.2.4-dev.1', tag: 'dev' });
    expect(parsePushCommit('fix transformer 1.2.3', '1.0.0')).toBeUndefined();
    expect(parsePushCommit('release 1.2.3\nbody mentions 9.9.9', '1.0.0')).toBeUndefined();
    expect(parsePushCommit('dev', '1.0.0')).toBeUndefined();
  });
});

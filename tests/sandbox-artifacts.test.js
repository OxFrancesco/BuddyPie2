import { describe, expect, test } from 'bun:test'
import {
  getSandboxArtifactManifestPath,
  parseSandboxArtifactManifest,
} from '../src/lib/artifacts.ts'

describe('sandbox artifact manifest path', () => {
  test('stores the live manifest under the sandbox-local .buddypie directory', () => {
    expect(getSandboxArtifactManifestPath('/home/daytona/example-repo')).toBe(
      '/home/daytona/example-repo/.buddypie/artifacts/current.json',
    )
  })
})

describe('parseSandboxArtifactManifest', () => {
  const manifestPath = '/home/daytona/example-repo/.buddypie/artifacts/current.json'

  test('returns empty when the manifest file is absent', () => {
    expect(
      parseSandboxArtifactManifest({
        manifestPath,
        content: null,
      }),
    ).toEqual({
      status: 'empty',
      manifestPath,
    })
  })

  test('returns invalid when the content is malformed JSON', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: '{"version":1,',
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.rawContent).toBe('{"version":1,')
  })

  test('returns invalid when the JSON does not match the manifest contract', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        generatedAt: new Date().toISOString(),
        spec: {},
      }),
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('returns invalid when spec is not a renderable json-render tree', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {},
      }),
    })

    expect(result.status).toBe('invalid')
    expect(result.manifestPath).toBe(manifestPath)
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('returns ready when the manifest matches the v1 contract', () => {
    const result = parseSandboxArtifactManifest({
      manifestPath,
      content: JSON.stringify({
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {
          root: 'heading-1',
          elements: {
            'heading-1': {
              type: 'Heading',
              props: {
                text: 'Wallet Summary',
                level: 'h2',
              },
            },
          },
        },
      }),
    })

    expect(result).toEqual({
      status: 'ready',
      manifestPath,
      manifest: {
        version: 1,
        kind: 'json-render',
        title: 'Wallet Summary',
        summary: 'A concise overview.',
        generatedAt: '2026-03-23T10:20:00.000Z',
        spec: {
          root: 'heading-1',
          elements: {
            'heading-1': {
              type: 'Heading',
              props: {
                text: 'Wallet Summary',
                level: 'h2',
              },
              children: [],
            },
          },
        },
      },
    })
  })
})

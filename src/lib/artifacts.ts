import { posix as pathPosix } from 'node:path'
import { z } from 'zod'

export const SANDBOX_ARTIFACT_MANIFEST_VERSION = 1 as const
export const SANDBOX_ARTIFACT_MANIFEST_KIND = 'json-render' as const
export const SANDBOX_ARTIFACT_RELATIVE_PATH = '.buddypie/artifacts/current.json'

const sandboxArtifactElementSchema = z.object({
  type: z.string().trim().min(1),
  props: z.record(z.string(), z.any()).default({}),
  children: z.array(z.string()).default([]),
  visible: z.any().optional(),
})

const sandboxArtifactSpecSchema = z
  .object({
    root: z.string().trim().min(1),
    elements: z.record(z.string(), sandboxArtifactElementSchema),
    state: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((spec, ctx) => {
    if (!(spec.root in spec.elements)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `spec.root must reference an element defined in spec.elements.`,
      })
    }
  })

export const sandboxArtifactManifestV1Schema = z.object({
  version: z.literal(SANDBOX_ARTIFACT_MANIFEST_VERSION),
  kind: z.literal(SANDBOX_ARTIFACT_MANIFEST_KIND),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1).optional(),
  generatedAt: z.string().trim().min(1),
  spec: sandboxArtifactSpecSchema,
})

export type SandboxArtifactManifestV1 = z.infer<
  typeof sandboxArtifactManifestV1Schema
>

export type SandboxArtifactReadResult =
  | {
      status: 'empty'
      manifestPath: string
    }
  | {
      status: 'invalid'
      manifestPath: string
      error: string
      rawContent: string
    }
  | {
      status: 'ready'
      manifestPath: string
      manifest: SandboxArtifactManifestV1
    }

export function getSandboxArtifactManifestPath(workspacePath: string) {
  return pathPosix.join(workspacePath, SANDBOX_ARTIFACT_RELATIVE_PATH)
}

export function parseSandboxArtifactManifest(args: {
  manifestPath: string
  content: string | null | undefined
}): SandboxArtifactReadResult {
  if (!args.content) {
    return {
      status: 'empty',
      manifestPath: args.manifestPath,
    }
  }

  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(args.content)
  } catch (error) {
    return {
      status: 'invalid',
      manifestPath: args.manifestPath,
      error:
        error instanceof Error ? error.message : 'Artifact manifest is not valid JSON.',
      rawContent: args.content,
    }
  }

  const parsedManifest = sandboxArtifactManifestV1Schema.safeParse(parsedJson)

  if (!parsedManifest.success) {
    return {
      status: 'invalid',
      manifestPath: args.manifestPath,
      error: parsedManifest.error.issues.map((issue) => issue.message).join('; '),
      rawContent: args.content,
    }
  }

  return {
    status: 'ready',
    manifestPath: args.manifestPath,
    manifest: parsedManifest.data,
  }
}

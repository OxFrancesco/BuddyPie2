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

const sandboxArtifactSimpleFieldSchema = z.object({
  label: z.string().trim().min(1),
  value: z.string().trim().min(1),
  color: z.string().trim().min(1).optional(),
  monospace: z.boolean().optional(),
})

const sandboxArtifactSimpleTableSchema = z.object({
  headers: z.array(z.string().trim().min(1)).min(1),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).default([]),
})

const sandboxArtifactSimpleCardSectionSchema = z.object({
  type: z.literal('card'),
  title: z.string().trim().min(1),
  fields: z.array(sandboxArtifactSimpleFieldSchema).optional(),
  table: sandboxArtifactSimpleTableSchema.optional(),
})

const sandboxArtifactSimpleAlertSectionSchema = z.object({
  type: z.literal('alert'),
  alert: z.enum(['info', 'success', 'warning', 'error']).optional(),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1).optional(),
})

const sandboxArtifactSimpleSeparatorSectionSchema = z.object({
  type: z.literal('separator'),
})

const sandboxArtifactSimpleRelationGraphNodeSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  detail: z.string().trim().min(1).optional(),
  tone: z.enum(['default', 'positive', 'negative', 'warning', 'neutral']).optional(),
  size: z.number().min(1).max(3).optional(),
})

const sandboxArtifactSimpleRelationGraphEdgeSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  tone: z.enum(['default', 'positive', 'negative', 'warning', 'neutral']).optional(),
  weight: z.number().min(1).max(4).optional(),
})

const sandboxArtifactSimpleRelationGraphSectionSchema = z.object({
  type: z.literal('relation-graph'),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  center: z.string().trim().min(1).optional(),
  height: z.number().min(280).max(1200).optional(),
  nodes: z.array(sandboxArtifactSimpleRelationGraphNodeSchema).min(1),
  edges: z.array(sandboxArtifactSimpleRelationGraphEdgeSchema).default([]),
})

const sandboxArtifactSimpleSectionSchema = z.union([
  sandboxArtifactSimpleCardSectionSchema,
  sandboxArtifactSimpleAlertSectionSchema,
  sandboxArtifactSimpleSeparatorSectionSchema,
  sandboxArtifactSimpleRelationGraphSectionSchema,
])

const sandboxArtifactSimpleSpecSchema = z.object({
  layout: z.literal('cards'),
  sections: z.array(sandboxArtifactSimpleSectionSchema).min(1),
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

function createArtifactElementId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`
}

function normalizeSimpleCellValue(value: string | number) {
  return typeof value === 'number' ? String(value) : value
}

function normalizeSimpleFieldValue(
  field: z.infer<typeof sandboxArtifactSimpleFieldSchema>,
) {
  if (field.monospace) {
    return `\`${field.value}\``
  }

  return field.value
}

function convertSimpleSpecToRenderSpec(
  simpleSpec: z.infer<typeof sandboxArtifactSimpleSpecSchema>,
) {
  const elements: Record<
    string,
    {
      type: string
      props: Record<string, unknown>
      children?: string[]
    }
  > = {}
  const rootId = 'artifact-root'
  const rootChildren: string[] = []

  elements[rootId] = {
    type: 'Stack',
    props: {
      direction: 'vertical',
      gap: 'lg',
    },
    children: rootChildren,
  }

  simpleSpec.sections.forEach((section, sectionIndex) => {
    const sectionId = createArtifactElementId('section', sectionIndex)
    rootChildren.push(sectionId)

    if (section.type === 'separator') {
      elements[sectionId] = {
        type: 'Separator',
        props: {
          orientation: 'horizontal',
        },
      }
      return
    }

    if (section.type === 'alert') {
      elements[sectionId] = {
        type: 'Alert',
        props: {
          title: section.title,
          message: section.body ?? null,
          type: section.alert ?? 'info',
        },
      }
      return
    }

    if (section.type === 'relation-graph') {
      const cardChildren: string[] = []
      elements[sectionId] = {
        type: 'Card',
        props: {
          title: section.title,
        },
        children: cardChildren,
      }

      if (section.description) {
        const descriptionId = `${sectionId}-description`
        cardChildren.push(descriptionId)
        elements[descriptionId] = {
          type: 'Text',
          props: {
            text: section.description,
            variant: 'muted',
          },
        }
      }

      const graphId = `${sectionId}-graph`
      cardChildren.push(graphId)
      elements[graphId] = {
        type: 'RelationGraph',
        props: {
          title: null,
          description: null,
          center: section.center ?? null,
          height: section.height ?? 560,
          nodes: section.nodes,
          edges: section.edges,
        },
      }
      return
    }

    const cardChildren: string[] = []
    elements[sectionId] = {
      type: 'Card',
      props: {
        title: section.title,
      },
      children: cardChildren,
    }

    if (section.fields && section.fields.length > 0) {
      const fieldsId = `${sectionId}-fields`
      cardChildren.push(fieldsId)
      elements[fieldsId] = {
        type: 'Table',
        props: {
          columns: ['Field', 'Value'],
          rows: section.fields.map((field) => [
            field.label,
            normalizeSimpleFieldValue(field),
          ]),
        },
      }
    }

    if (section.fields?.length && section.table) {
      const separatorId = `${sectionId}-separator`
      cardChildren.push(separatorId)
      elements[separatorId] = {
        type: 'Separator',
        props: {
          orientation: 'horizontal',
        },
      }
    }

    if (section.table) {
      const tableId = `${sectionId}-table`
      cardChildren.push(tableId)
      elements[tableId] = {
        type: 'Table',
        props: {
          columns: section.table.headers,
          rows: section.table.rows.map((row) =>
            row.map((cell) => normalizeSimpleCellValue(cell)),
          ),
        },
      }
    }
  })

  return {
    root: rootId,
    elements,
  }
}

function normalizeSandboxArtifactManifestInput(parsedJson: unknown) {
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    return parsedJson
  }

  const normalizedManifest = {
    ...parsedJson,
  } as Record<string, unknown>

  if (normalizedManifest.version === '1') {
    normalizedManifest.version = 1
  }

  const simpleSpecResult = sandboxArtifactSimpleSpecSchema.safeParse(
    normalizedManifest.spec,
  )

  if (simpleSpecResult.success) {
    normalizedManifest.spec = convertSimpleSpecToRenderSpec(simpleSpecResult.data)
  }

  return normalizedManifest
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

  parsedJson = normalizeSandboxArtifactManifestInput(parsedJson)

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

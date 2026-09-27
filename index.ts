import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"])
const definePlugin = <T>(plugin: T) => plugin

const number = (minimum: number, maximum: number, description: string) => ({
  type: "number", minimum, maximum, description,
})

const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    straightenDegrees: number(-45, 45, "Clockwise rotation needed to make the subject, horizon, or architecture level. Use 0 when the skew is purposeful."),
    cropCenterX: number(0, 1, "Horizontal center of the square crop, normalized from left to right."),
    cropCenterY: number(0, 1, "Vertical center of the square crop, normalized from top to bottom."),
    cropScale: number(0.5, 1, "Fraction of the largest safe square crop to retain. Prefer a loose crop unless a tighter composition is clearly stronger."),
    exposure: number(-2, 2, "Photoshop Exposure correction in stops. Keep natural and protect highlights."),
    brightness: number(-50, 50, "Photoshop Brightness correction."),
    contrast: number(-50, 50, "Photoshop Contrast correction."),
    levelsBlack: number(0, 40, "Photoshop Levels black input point."),
    levelsWhite: number(215, 255, "Photoshop Levels white input point."),
    levelsGamma: number(0.5, 1.5, "Photoshop Levels midtone gamma; 1 is neutral."),
    curveShadows: number(-30, 30, "Photoshop Curves output offset near input 64."),
    curveMidtones: number(-30, 30, "Photoshop Curves output offset near input 128."),
    curveHighlights: number(-30, 30, "Photoshop Curves output offset near input 192."),
    vibrance: number(-50, 50, "Photoshop Vibrance adjustment."),
    saturation: number(-30, 30, "Photoshop Hue/Saturation saturation adjustment."),
    cyanRed: number(-30, 30, "Photoshop midtone Color Balance: negative adds cyan, positive adds red."),
    magentaGreen: number(-30, 30, "Photoshop midtone Color Balance: negative adds magenta, positive adds green."),
    yellowBlue: number(-30, 30, "Photoshop midtone Color Balance: negative adds yellow, positive adds blue."),
    caption: {
      type: "string",
      minLength: 1,
      maxLength: 1800,
      description: "Engaging, truthful Instagram caption tailored to this photo. Use supplied metadata when relevant; do not invent identities, locations, events, or facts.",
    },
    hashtags: {
      type: "array",
      minItems: 3,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Za-z0-9_]+$", minLength: 2, maxLength: 64 },
      description: "Current, relevant Instagram hashtags without #. Mix specific and broader discovery terms; avoid unrelated, banned, repetitive, or spam-like tags.",
    },
  },
  required: [
    "straightenDegrees", "cropCenterX", "cropCenterY", "cropScale",
    "exposure", "brightness", "contrast", "levelsBlack", "levelsWhite", "levelsGamma",
    "curveShadows", "curveMidtones", "curveHighlights", "vibrance", "saturation",
    "cyanRed", "magentaGreen", "yellowBlue", "caption", "hashtags",
  ],
} as const

type Edit = {
  straightenDegrees: number
  cropCenterX: number
  cropCenterY: number
  cropScale: number
  exposure: number
  brightness: number
  contrast: number
  levelsBlack: number
  levelsWhite: number
  levelsGamma: number
  curveShadows: number
  curveMidtones: number
  curveHighlights: number
  vibrance: number
  saturation: number
  cyanRed: number
  magentaGreen: number
  yellowBlue: number
  caption: string
  hashtags: string[]
}

type SourceMetadata = {
  title: string
  description: string
  extendedDescription: string
  keywords: string
  creator: string
  copyright: string
  location: string
  gps: string
}

type Entry = {
  input: string
  output: string
  preview: string
  metadata?: SourceMetadata
}

type Job = {
  id: string
  sessionID: string
  folder: string
  outputFolder: string
  work: string
  entries: Entry[]
  index: number
  overwrite: boolean
  completed: string[]
  skipped: string[]
}

const jobs = new Map<string, Job>()
const sessionJobs = new Map<string, string>()

function clamp(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

async function runPhotoshop(pluginDirectory: string, script: string, config: unknown, signal: AbortSignal) {
  const runner = path.join(pluginDirectory, "scripts", "invoke-photoshop.ps1")
  const scriptPath = path.join(pluginDirectory, "scripts", script)
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64")
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", runner, "-ScriptPath", scriptPath, "-ConfigBase64", encoded,
    ], { windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const abort = () => child.kill()
    signal.addEventListener("abort", abort, { once: true })
    child.once("error", reject)
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) return reject(new Error("Instagram processing was cancelled."))
      if (code === 0) return resolve()
      reject(new Error((stderr || stdout || `Photoshop exited with code ${code}`).trim()))
    })
  })
}

function decodeField(value = "") {
  if (!value) return ""
  try { return Buffer.from(value, "base64").toString("utf8") } catch { return "" }
}

async function prepareEntry(pluginDirectory: string, job: Job, signal: AbortSignal) {
  const entry = job.entries[job.index]
  const metadataFile = path.join(job.work, `metadata-${job.index}.tsv`)
  await runPhotoshop(pluginDirectory, "prepare.jsx", {
    input: entry.input,
    preview: entry.preview,
    metadata: metadataFile,
  }, signal)
  await stat(entry.preview)
  // Preserve leading empty fields (for example, an empty Title). trim() would
  // remove the first tab and shift every following metadata value one column.
  const fields = (await readFile(metadataFile, "utf8")).replace(/[\r\n]+$/, "").split("\t")
  entry.metadata = {
    title: decodeField(fields[0]),
    description: decodeField(fields[1]),
    extendedDescription: decodeField(fields[2]),
    keywords: decodeField(fields[3]),
    creator: decodeField(fields[4]),
    copyright: decodeField(fields[5]),
    location: decodeField(fields[6]),
    gps: decodeField(fields[7]),
  }
  await rm(metadataFile, { force: true })
}

function metadataSummary(metadata: SourceMetadata) {
  const values = [
    ["Title", metadata.title],
    ["Description", metadata.description],
    ["Existing Extended Description", metadata.extendedDescription],
    ["Keywords", metadata.keywords],
    ["Creator", metadata.creator],
    ["Copyright", metadata.copyright],
    ["Location", metadata.location],
    ["GPS", metadata.gps],
  ].filter(([, value]) => value)
  return values.length
    ? values.map(([name, value]) => `${name}: ${value.slice(0, 2000)}`).join("\n")
    : "No useful source metadata was found."
}

async function queueCurrent(ctx: any, job: Job, message: string) {
  const entry = job.entries[job.index]
  await ctx.session.prompt({
    sessionID: job.sessionID,
    delivery: "queue",
    text: `${message}\nJob: ${job.id}\nImage ${job.index + 1} of ${job.entries.length}: ${path.basename(entry.input)}\n\nSource metadata:\n${metadataSummary(entry.metadata!)}\n\nInspect the attached pixels. Call instagram_pre_processor_apply once with an image-specific square composition, straightening, and restrained Photoshop exposure/color/contrast/Levels/Curves/tone adjustments. Level a genuinely tilted horizon, subject, or architectural vertical, but preserve clearly intentional Dutch angles or purposeful skew by using 0 degrees. Create a truthful, engaging Instagram caption and research/select current relevant hashtags for strong discoverability; never promise virality or add unrelated trending tags. The final caption and hashtags replace the standard Metadata Description; Extended Description is cleared.`,
    files: [{ uri: pathToFileURL(entry.preview).href }],
  })
}

async function nextUnprocessed(job: Job) {
  while (job.index < job.entries.length && !job.overwrite) {
    try {
      await stat(job.entries[job.index].output)
      job.skipped.push(job.entries[job.index].output)
      job.index += 1
    } catch {
      return
    }
  }
}

function instagramText(edit: Edit) {
  const caption = edit.caption.trim()
  const seen = new Set<string>()
  const tags = edit.hashtags
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter((tag) => {
      const key = tag.toLocaleLowerCase()
      if (!tag || seen.has(key)) return false
      seen.add(key)
      return true
    })
  if (tags.length < 3) throw new Error("Provide at least three relevant hashtags.")
  const text = `${caption}\n\n${tags.map((tag) => `#${tag}`).join(" ")}`
  if (text.length > 2200) throw new Error("The Instagram caption and hashtags must total no more than 2,200 characters.")
  return text
}

export default definePlugin({
  id: "instagram-pre-processor",
  async setup(ctx) {
    const pluginDirectory = path.dirname(fileURLToPath(import.meta.url))
    const configuredModel = process.env.INSTAGRAM_PRE_PROCESSOR_MODEL
      || (typeof ctx.options.model === "string" ? ctx.options.model : "openai/gpt-6-luna")
    const [requestedProvider, ...modelParts] = configuredModel.split("/")
    const requestedModel = modelParts.join("/")

    await ctx.session.hook("context", (event) => {
      const active = sessionJobs.has(event.sessionID)
      const allowed = new Set(active
        ? ["instagram_pre_processor_apply", "instagram_pre_processor_cancel"]
        : ["instagram_pre_processor_start"])
      for (const name of Object.keys(event.tools)) {
        if (name.startsWith("instagram_pre_processor_") && !allowed.has(name)) delete event.tools[name]
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "instagram-pre-processor",
        description: "Create AI-cropped, Photoshop-finished 1:1 Instagram JPEGs with captions and hashtags.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const folder = prompt.text.trim()
          if (!folder) throw new Error("Provide an absolute folder path, for example: /instagram-pre-processor C:\\Photos")
          try {
            await ctx.session.switchModel({ sessionID, model: { providerID: requestedProvider, id: requestedModel } })
          } catch {
            await ctx.session.switchModel({ sessionID, model: { providerID: "openai", id: "gpt-5.6-terra" } })
          }
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: `Process JPEG images directly in ${JSON.stringify(folder)}. Call instagram_pre_processor_start once. For each queued image, inspect the actual attachment and source metadata, then call apply with an intentional 1:1 composition, appropriate straightening, polished but natural Photoshop corrections, and a photo-specific Instagram caption plus current relevant hashtags. End the turn whenever the next image is queued. Never restart or cancel unless explicitly asked. Continue until complete.`,
          })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "instagram_pre_processor",
        description: "AI-guided Photoshop preparation of local JPEG images for square Instagram posts.",
      })

      editor.add({
        name: "start",
        description: "Start a non-recursive JPEG job and queue the first image preview.",
        options: { namespace: "instagram_pre_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            folder: { type: "string", description: "Absolute path to a folder containing JPEG images." },
            overwrite: { type: "boolean", description: "Replace existing -Insta outputs. Defaults to false." },
          },
          required: ["folder"],
        },
        execute: async (input: { folder: string; overwrite?: boolean }, context) => {
          if (sessionJobs.has(context.sessionID)) throw new Error("This session already has an active Instagram job.")
          if (!path.isAbsolute(input.folder)) throw new Error("The JPEG folder path must be absolute.")
          const folder = path.resolve(input.folder)
          if (!(await stat(folder)).isDirectory()) throw new Error(`Not a folder: ${folder}`)
          const names = (await readdir(folder))
            .filter((name) => JPEG_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          if (!names.length) throw new Error(`No JPEG images were found directly in ${folder}`)

          const stems = new Set<string>()
          for (const name of names) {
            const stem = path.parse(name).name.toLocaleLowerCase()
            if (stems.has(stem)) throw new Error(`Duplicate JPEG basename: ${path.parse(name).name}. Move or rename one rendition before processing.`)
            stems.add(stem)
          }

          const id = randomUUID()
          const work = path.join(tmpdir(), "Instagram_Pre_Processor", id)
          const outputFolder = path.join(folder, "Instagram")
          await mkdir(work, { recursive: true })
          await mkdir(outputFolder, { recursive: true })
          const entries = names.map((name, index) => ({
            input: path.join(folder, name),
            output: path.join(outputFolder, `${path.parse(name).name}-Insta.jpg`),
            preview: path.join(work, `${String(index + 1).padStart(5, "0")}.jpg`),
          }))
          const job: Job = {
            id, sessionID: context.sessionID, folder, outputFolder, work, entries,
            index: 0, overwrite: input.overwrite === true, completed: [], skipped: [],
          }
          jobs.set(id, job)
          sessionJobs.set(context.sessionID, id)
          try {
            await nextUnprocessed(job)
            if (job.index >= entries.length) {
              jobs.delete(id)
              sessionJobs.delete(context.sessionID)
              await rm(work, { recursive: true, force: true })
              return { content: `Nothing to process; all ${job.skipped.length} Instagram output(s) already exist.` }
            }
            await context.progress({ status: `Preparing JPEG ${job.index + 1} of ${entries.length}` })
            await prepareEntry(pluginDirectory, job, context.signal)
            await queueCurrent(ctx, job, `Found ${entries.length} JPEG image(s). Existing outputs are ${job.overwrite ? "replaced" : "skipped"}.`)
            return { content: "Queued the first JPEG as an actual image attachment. End this turn and wait for the queued image message." }
          } catch (error) {
            jobs.delete(id)
            sessionJobs.delete(context.sessionID)
            await rm(work, { recursive: true, force: true })
            throw error
          }
        },
      })

      editor.add({
        name: "apply",
        description: "Apply AI-selected straightening, square crop, and Photoshop tonal/color finishing; replace Metadata Description with the Instagram text, clear Extended Description, and continue the batch.",
        options: { namespace: "instagram_pre_processor", codemode: true },
        input: {
          type: "object",
          additionalProperties: false,
          properties: { jobID: { type: "string" }, edit: EDIT_SCHEMA },
          required: ["jobID", "edit"],
        },
        execute: async (input: { jobID: string; edit: Edit }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) throw new Error("Unknown or completed Instagram job.")
          if (job.sessionID !== context.sessionID) throw new Error("This Instagram job belongs to another session.")
          const entry = job.entries[job.index]
          const description = instagramText(input.edit)
          await context.progress({ status: `Creating ${path.basename(entry.output)} (${job.index + 1}/${job.entries.length})` })
          await runPhotoshop(pluginDirectory, "process.jsx", {
            input: entry.input,
            output: entry.output,
            overwrite: job.overwrite,
            outputSize: 1080,
            description,
            straightenDegrees: clamp(input.edit.straightenDegrees, 0, -45, 45),
            cropCenterX: clamp(input.edit.cropCenterX, 0.5, 0, 1),
            cropCenterY: clamp(input.edit.cropCenterY, 0.5, 0, 1),
            cropScale: clamp(input.edit.cropScale, 0.96, 0.5, 1),
            finish: {
              exposure: clamp(input.edit.exposure, 0, -2, 2),
              brightness: clamp(input.edit.brightness, 0, -50, 50),
              contrast: clamp(input.edit.contrast, 0, -50, 50),
              levelsBlack: clamp(input.edit.levelsBlack, 0, 0, 40),
              levelsWhite: clamp(input.edit.levelsWhite, 255, 215, 255),
              levelsGamma: clamp(input.edit.levelsGamma, 1, 0.5, 1.5),
              curveShadows: clamp(input.edit.curveShadows, 0, -30, 30),
              curveMidtones: clamp(input.edit.curveMidtones, 0, -30, 30),
              curveHighlights: clamp(input.edit.curveHighlights, 0, -30, 30),
              vibrance: clamp(input.edit.vibrance, 0, -50, 50),
              saturation: clamp(input.edit.saturation, 0, -30, 30),
              cyanRed: clamp(input.edit.cyanRed, 0, -30, 30),
              magentaGreen: clamp(input.edit.magentaGreen, 0, -30, 30),
              yellowBlue: clamp(input.edit.yellowBlue, 0, -30, 30),
            },
          }, context.signal)
          await stat(entry.output)
          job.completed.push(entry.output)
          job.index += 1
          await nextUnprocessed(job)
          if (job.index >= job.entries.length) {
            jobs.delete(job.id)
            sessionJobs.delete(job.sessionID)
            await rm(job.work, { recursive: true, force: true })
            return { content: `Instagram processing complete. Created ${job.completed.length} image(s), skipped ${job.skipped.length}. Output folder: ${job.outputFolder}` }
          }
          await context.progress({ status: `Preparing JPEG ${job.index + 1} of ${job.entries.length}` })
          await prepareEntry(pluginDirectory, job, context.signal)
          await queueCurrent(ctx, job, `Created ${path.basename(entry.output)}.`)
          return { content: "Created the Instagram JPEG and queued the next image. End this turn and wait for the queued image message." }
        },
      })

      editor.add({
        name: "cancel",
        description: "Cancel only when the user explicitly requests cancellation.",
        options: { namespace: "instagram_pre_processor", codemode: true },
        input: {
          type: "object", additionalProperties: false,
          properties: { jobID: { type: "string" } }, required: ["jobID"],
        },
        execute: async (input: { jobID: string }, context) => {
          const job = jobs.get(input.jobID)
          if (!job) return { content: "Job is already completed, cancelled, or unknown." }
          if (job.sessionID !== context.sessionID) throw new Error("This Instagram job belongs to another session.")
          jobs.delete(job.id)
          sessionJobs.delete(job.sessionID)
          await rm(job.work, { recursive: true, force: true })
          return { content: `Cancelled job ${job.id}. Completed Instagram outputs were retained.` }
        },
      })
    })

    return async () => {
      await Promise.all([...jobs.values()].map((job) => rm(job.work, { recursive: true, force: true })))
      jobs.clear()
      sessionJobs.clear()
    }
  },
})

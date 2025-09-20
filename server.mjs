// server.mjs
import express from "express";
import bodyParser from "body-parser";

// =================== ENV VARS ===================
// Set these in your hosting (Render) dashboard.
const {
  PORT = 3000,
  PUBLIC_BASE_URL, // e.g. https://airtable-wavespeed-server.onrender.com
  WAVESPEED_API_KEY,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  // Exact Airtable table names (change if you used different names)
  AIRTABLE_TABLE_RECREATOR = "Pinterest Recreator",
  AIRTABLE_TABLE_POSES = "Pose Variations",
} = process.env;

// Soft warnings to help you remember to fill envs
if (!PUBLIC_BASE_URL) console.warn("WARNING: PUBLIC_BASE_URL is not set.");
if (!WAVESPEED_API_KEY) console.warn("WARNING: WAVESPEED_API_KEY is not set.");
if (!AIRTABLE_TOKEN) console.warn("WARNING: AIRTABLE_TOKEN is not set.");
if (!AIRTABLE_BASE_ID) console.warn("WARNING: AIRTABLE_BASE_ID is not set.");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// =================== AIRTABLE HELPERS ===================
function atBase(tableName) {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    tableName
  )}`;
}

const atHeaders = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
};

async function getRecord(tableName, recordId) {
  const r = await fetch(`${atBase(tableName)}/${recordId}`, {
    headers: atHeaders,
  });
  if (!r.ok) throw new Error(`Airtable getRecord failed: ${r.status}`);
  return r.json(); // { id, fields, ... }
}

async function updateRecord(tableName, recordId, fields) {
  const r = await fetch(atBase(tableName), {
    method: "PATCH",
    headers: atHeaders,
    body: JSON.stringify({ records: [{ id: recordId, fields }] }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Airtable updateRecord failed: ${r.status} ${txt}`);
  }
  return r.json();
}

// =================== WAVESPEED CALL ===================
// ⚠️ TODO: Update endpoint path + request body keys to the EXACT Seedream 4.0 spec.
const WAVESPEED_BASE = "https://api.wavespeed.ai";

async function wavespeedCreateJob(payload) {
  const r = await fetch(`${WAVESPEED_BASE}/v1/seedream4/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WAVESPEED_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Wavespeed createJob failed: ${r.status} ${txt}`);
  }
  // Expected: { job_id, batch_id, status, ... }
  return r.json();
}

// =================== PAYLOAD BUILDERS ===================
// These map Airtable fields → Wavespeed request body.
// Rename keys to match Seedream 4.0 (see TODO comments).

function buildRecreatorPayload(recordId, f) {
  const refUrl = f["Reference Image URL"];
  const refAtt = f["Reference Image"];
  const reference_image_url =
    refUrl || (Array.isArray(refAtt) && refAtt[0]?.url) || undefined;

  // ⚠️ TODO: Rename keys to whatever Seedream 4.0 expects (e.g., model_id, ref_image, etc.)
  return {
    model: f["Model ID"],
    prompt: f["Prompt"] || "",
    negative_prompt: f["Negative Prompt"] || "",
    cfg_scale: typeof f["CFG"] === "number" ? f["CFG"] : 8,
    steps: typeof f["Steps"] === "number" ? f["Steps"] : 35,
    sampler: f["Sampler"] || "DPM++ 2M Karras",
    face_lock: !!f["Face Lock"],
    reference_strength:
      typeof f["Reference Strength"] === "number" ? f["Reference Strength"] : 0.85,
    pose_control: !!f["Pose Control"],
    lighting_control: !!f["Lighting Control"],

    mode: "recreate",
    reference_image_url, // <- if Seedream needs 'ref_image', rename it there

    webhook_url: `${PUBLIC_BASE_URL}/wavespeed/callback`,
    metadata: {
      airtable_record_id: recordId,
      table: AIRTABLE_TABLE_RECREATOR,
      mode: "recreate",
    },
  };
}

function buildPosesPayload(recordId, f) {
  const srcAtt = f["Source Image"];
  const source_image_url =
    Array.isArray(srcAtt) && srcAtt[0]?.url ? srcAtt[0].url : undefined;

  const poseLines = (f["Poses"] || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // ⚠️ TODO: Rename keys to Seedream spec if needed
  const payload = {
    model: f["Model ID"],
    prompt: f["Prompt"] || "",
    negative_prompt: f["Negative Prompt"] || "",
    cfg_scale: typeof f["CFG"] === "number" ? f["CFG"] : 8,
    steps: typeof f["Steps"] === "number" ? f["Steps"] : 35,
    sampler: f["Sampler"] || "DPM++ 2M Karras",
    face_lock: !!f["Face Lock"],
    reference_strength:
      typeof f["Reference Strength"] === "number" ? f["Reference Strength"] : 0.85,
    pose_control: !!f["Pose Control"],
    lighting_control: !!f["Lighting Control"],

    mode: "pose_variations",
    webhook_url: `${PUBLIC_BASE_URL}/wavespeed/callback`,
    metadata: {
      airtable_record_id: recordId,
      table: AIRTABLE_TABLE_POSES,
      mode: "pose_variations",
    },
  };

  if (source_image_url) payload.source_image_url = source_image_url; // rename if needed
  if (poseLines.length) payload.poses = poseLines;

  return payload;
}

// =================== ROUTES ===================

// Quick health check
app.get("/", (_, res) => res.send("OK"));

// A) Pinterest Recreator — start job from a record in "Pinterest Recreator"
app.post("/generate/recreator", async (req, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId)
      return res.status(400).json({ error: "recordId required" });

    // Read fields from Airtable
    const { fields } = await getRecord(AIRTABLE_TABLE_RECREATOR, recordId);

    // Mark as running
    await updateRecord(AIRTABLE_TABLE_RECREATOR, recordId, {
      Status: "running",
      ["Error Message"]: "",
    });

    // Build payload, create job on Wavespeed
    const payload = buildRecreatorPayload(recordId, fields);
    const ws = await wavespeedCreateJob(payload);

    // Save job IDs (optional fields—safe if the columns don't exist)
    await updateRecord(AIRTABLE_TABLE_RECREATOR, recordId, {
      ["Wavespeed Job ID"]: ws.job_id || "",
      ["Batch ID"]: ws.batch_id || "",
    });

    res.json({ ok: true, job: ws });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// B) Pose Variations — start job from a record in "Pose Variations"
app.post("/generate/poses", async (req, res) => {
  try {
    const { recordId } = req.body;
    if (!recordId)
      return res.status(400).json({ error: "recordId required" });

    const { fields } = await getRecord(AIRTABLE_TABLE_POSES, recordId);

    await updateRecord(AIRTABLE_TABLE_POSES, recordId, {
      Status: "running",
      ["Error Message"]: "",
    });

    const payload = buildPosesPayload(recordId, fields);
    const ws = await wavespeedCreateJob(payload);

    await updateRecord(AIRTABLE_TABLE_POSES, recordId, {
      ["Wavespeed Job ID"]: ws.job_id || "",
      ["Batch ID"]: ws.batch_id || "",
    });

    res.json({ ok: true, job: ws });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// C) Unified callback — Wavespeed posts results here for BOTH flows
app.post("/wavespeed/callback", async (req, res) => {
  try {
    // Expected shape (adjust if Seedream differs):
    // {
    //   status: "succeeded" | "failed",
    //   images: [{ url }, ...],
    //   error: "optional message",
    //   metadata: { airtable_record_id, table, mode }
    // }
    const { status, images = [], error, metadata } = req.body || {};
    const recordId = metadata?.airtable_record_id;
    const table = metadata?.table;

    if (!recordId || !table) {
      console.warn("Callback missing airtable_record_id or table in metadata.");
      return res.json({ ok: true });
    }

    if (status === "succeeded") {
      // Attach images and mark done
      const atts = images.map((img) => ({ url: img.url }));
      await updateRecord(table, recordId, {
        Status: "done",
        ["Output Images"]: atts,
        ["Error Message"]: "",
      });
    } else if (status === "failed") {
      await updateRecord(table, recordId, {
        Status: "error",
        ["Error Message"]: error || "Unknown Wavespeed error",
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

import { writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { batchSchema, eventSchema, grantDraftSchema, manualInputSchema } from "../src/core/schema";
import { envelopeSchema } from "../src/core/crypto";
await mkdir("protocol", { recursive: true });
for (const [name, schema] of Object.entries({ batch: batchSchema, event: eventSchema, grant: grantDraftSchema, manual: manualInputSchema, envelope: envelopeSchema })) {
    await writeFile(`protocol/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n");
}

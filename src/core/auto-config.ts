import { z } from "zod";
import { id } from "./schema";

export const autoConfigSchema = z.strictObject({ version: z.literal(1), accountId: id,
    grantId: z.uuid(), passphrase: z.string().min(16).max(1024) });
export type AutoConfig = z.infer<typeof autoConfigSchema>;
export interface AutoStorage {
    readAuto(): Promise<string | undefined>;
    writeAuto(ciphertext: string | undefined): Promise<void>;
}
export interface AutoProtection {
    available(): Promise<boolean>;
    protect(config: AutoConfig): Promise<string>;
    restore(ciphertext: string, accountId: string): Promise<AutoConfig | undefined>;
}

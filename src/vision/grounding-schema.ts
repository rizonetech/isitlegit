// The Muse Spark logo grounding request and answer schema (D03 T03 §4), shared by the Worker
// detector and the Node recall runner so the measured call is the shipped call. Pure zod and
// strings: no Worker imports, so both runtimes load it.
import { z } from "zod";

export const groundingSchema = z
  .object({
    boxes: z
      .array(
        z
          .object({
            x_min: z.number().int().min(-50).max(1050),
            y_min: z.number().int().min(-50).max(1050),
            x_max: z.number().int().min(-50).max(1050),
            y_max: z.number().int().min(-50).max(1050),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type GroundingAnswer = z.infer<typeof groundingSchema>;

export const GROUNDING_TASK = [
  'You are an object grounding expert. Provide the bounding box coordinates of the object in the image: "the brand logo".',
  "Ensure the object accurately matches the request and do not miss any object.",
  "Answer with boxes as x_min, y_min, x_max, y_max on a normalized 0-1000 grid with (0,0) at the top-left.",
  "If you cannot find a brand logo, return an empty boxes list.",
].join("\n");

export function groundingRequest(imageDataUrl: string) {
  return {
    name: "logo_grounding",
    model: "muse-spark-1.3",
    instructions: GROUNDING_TASK,
    max_output_tokens: 800,
    reasoning: { effort: "low" as const },
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: "Find the brand logo in this image." },
          { type: "input_image" as const, image_url: imageDataUrl, detail: "auto" as const },
        ],
      },
    ],
  };
}

// Lets a plain Node process load the Worker's TypeScript, whose relative imports carry no extension (the bundler
// resolves them). Loaded with `node --import` by the tests that run source under a constrained heap.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try {
        return await next(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + ".ts", context);
        throw error;
      }
    }
  `)}`,
);

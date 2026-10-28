// Lets a plain Node process load the Worker's TypeScript the way the bundler does: relative imports carry no extension,
// and a CommonJS package's `exports.default` is its default export (@kenjiuno/msgreader; Node's own loader hands back
// the whole exports object). Loaded with `node --import` by the tests that run source under a constrained heap.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
    const DEFAULT_EXPORT = new Set(["@kenjiuno/msgreader"]);
    export async function resolve(specifier, context, next) {
      // The package resolved as usual, then wrapped; the wrapper imports it by its file URL.
      if (DEFAULT_EXPORT.has(specifier))
        return { url: "default-export:" + (await next(specifier, context)).url, shortCircuit: true };
      try {
        return await next(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + ".ts", context);
        throw error;
      }
    }
    export async function load(url, context, next) {
      if (!url.startsWith("default-export:")) return next(url, context);
      const target = JSON.stringify(url.slice("default-export:".length));
      return {
        format: "module",
        source: "import m from " + target + "; export default m.default ?? m;",
        shortCircuit: true,
      };
    }
  `)}`,
);

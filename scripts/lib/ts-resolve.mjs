// A resolve hook for scripts that import Worker modules written with extensionless relative imports (the Worker's
// bundler and Vitest accept them, Node's type stripping does not): `./bank` is tried as `./bank.ts`. Registered by
// scripts/seed-demo.ts (D07 T07 §1); it changes nothing for a specifier that already resolves.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    throw error;
  }
}

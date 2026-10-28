// A fixture imported with `?raw` arrives as its text (Vite); the forward fixtures are ASCII, so the bytes are exact.
declare module "*?raw" {
  const text: string;
  export default text;
}

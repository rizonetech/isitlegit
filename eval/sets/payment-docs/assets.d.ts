// A fixture imported with `?inline` arrives as a base64 data URL (Vite).
declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}

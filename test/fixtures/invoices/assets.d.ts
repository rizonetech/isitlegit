// A fixture imported with `?inline` arrives as a base64 data URL (Vite), the way the Worker tests read binary files.
declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}

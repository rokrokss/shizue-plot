/** A file the bundler emits as it is, imported for its address (`?url`, see `next.config.ts`). */
declare module '*?url' {
  const url: string;
  export default url;
}

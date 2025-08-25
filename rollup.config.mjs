import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/index.ts",
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
    exports: "named",
  },
  external: [
    "jotai",
    "jotai/vanilla",
    "jotai/vanilla/internals",
    "react",
    "react-dom"
  ],
  plugins: [
    resolve({
      browser: true,
      extensions: [".mjs", ".js", ".json", ".node", ".ts", ".tsx"],
    }),
    commonjs(),
    typescript({
      tsconfig: "tsconfig.esm.json",
      declaration: true,
      declarationMap: true,
      sourceMap: true,
    }),
  ],
};

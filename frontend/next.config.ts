import type { NextConfig } from "next";

import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "..", ".env") });

const nextConfig: NextConfig = {
  output: "standalone",   // requerido para Docker en Cloud Run
  reactCompiler: true,
};

export default nextConfig;

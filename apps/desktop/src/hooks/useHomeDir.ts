import { useEffect, useState } from "react";

export function useHomeDir() {
  const [homeDir, setHomeDir] = useState<string | null>(null);

  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then(({ homeDir: resolveHomeDir }) => resolveHomeDir())
      .then(setHomeDir)
      .catch(() => setHomeDir(null));
  }, []);

  return homeDir;
}

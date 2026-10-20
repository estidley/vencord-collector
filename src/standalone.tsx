import * as React from "react";
import { createRoot } from "react-dom/client";
import { Collector } from "./core/collector";
import { IndexedDbStorage } from "./core/storage";
import { createPanel } from "./ui/Panel";

const Panel = createPanel(React, new Collector(new IndexedDbStorage()));
createRoot(document.getElementById("root")!).render(<Panel />);

// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";
import { React } from "@webpack/common";
import { Collector } from "../core/collector";
import { IndexedDbStorage } from "../core/storage";
import { createPanel } from "../ui/Panel";

const collector = new Collector(new IndexedDbStorage());
collector.suspend();
let Panel: ReturnType<typeof createPanel> | undefined;

function SettingsPanel() {
    // Vencord's React export is resolved after plugin modules load. Read it only at render time.
    Panel ??= createPanel(React, collector);
    return <Panel />;
}

export default definePlugin({
    name: "MessageCollector",
    description: "Experimental local file import and encrypted export panel. No live message collection.",
    authors: [], // Private plugin: no invented Discord author ID.
    enabledByDefault: false,
    settingsAboutComponent: SettingsPanel,
    start() { collector.resume(); },
    stop() { collector.suspend(); }
});

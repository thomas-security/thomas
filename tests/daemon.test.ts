import { describe, expect, it } from "bun:test";
import { renderPlist } from "../src/daemon/launchd.js";
import { renderSystemdUnit } from "../src/daemon/systemd.js";

describe("renderPlist", () => {
  it("emits a valid plist with KeepAlive and the program arguments", () => {
    const xml = renderPlist({
      label: "com.trustunknown.thomas",
      programArguments: ["/usr/local/bin/node", "/path/to/cli.js", "proxy", "serve", "--port", "51168"],
      workingDirectory: "/Users/x",
      logPath: "/Users/x/.thomas/proxy.log",
      home: "/Users/x",
    });
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.trustunknown.thomas</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/path/to/cli.js</string>");
    expect(xml).toContain("<string>--port</string>");
    expect(xml).toContain("<string>51168</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>StandardOutPath</key>");
    expect(xml).toContain("<string>/Users/x/.thomas/proxy.log</string>");
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = renderPlist({
      label: "com.example & co",
      programArguments: ["/path with \"quotes\""],
      workingDirectory: "/x",
      logPath: "/x/log",
      home: "/x",
    });
    expect(xml).toContain("com.example &amp; co");
    expect(xml).toContain("&quot;quotes&quot;");
    expect(xml).not.toContain("com.example & co<");
  });
});

describe("renderSystemdUnit", () => {
  it("emits a valid unit with Restart=on-failure and KeepAlive-equivalent", () => {
    const unit = renderSystemdUnit({
      programExec: "/usr/bin/node",
      programPrefixArgs: ["/usr/lib/thomas/cli.js"],
      port: 51168,
      homeDir: "/home/user",
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/thomas/cli.js proxy serve --port 51168");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("StandardOutput=append:/home/user/.thomas/proxy.log");
  });

  it("quotes paths containing spaces", () => {
    const unit = renderSystemdUnit({
      programExec: "/usr/bin/node",
      programPrefixArgs: ["/path with space/cli.js"],
      port: 51168,
      homeDir: "/home/user",
    });
    expect(unit).toContain('"/path with space/cli.js"');
  });
});

import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  onSetModelSettingsScopeMode,
  onToggleSkillCommands,
}: SettingsGeneralSectionProps) {
  return (
    <>
      <SettingsGroup title="Agent">
        <SettingsRow
          title="Model settings scope"
          description="Apply the default model and enabled models everywhere, or set them per repo."
        >
          <SettingsSegmented
            label="Model settings scope"
            options={[
              { value: "app-global", label: "App global" },
              { value: "per-repo", label: "Per repo" },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title="Skill slash commands"
          description="Offer each skill as a slash command in the composer."
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label="Enable skill slash commands"
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Terminal">
        <SettingsRow
          title="Shell"
          description="The integrated terminal runs bash in the selected thread’s Vercel Sandbox."
        />
      </SettingsGroup>
    </>
  );
}

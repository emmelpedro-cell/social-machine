import { useEffect, useState } from 'react'
import type { MediaToolsStatus } from '../../../shared/media'
import type { AppInfo, Project, Settings, SettingsUpdateInput } from '../../../shared/schemas'
import { HEX_COLOR } from '../../../shared/schemas'
import type { WatchFolderStatus } from '../../../shared/watch'
import type { EncoderInfo } from '../../../shared/editor'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { WatchFoldersPanel } from '../components/WatchFoldersPanel'

type Props = {
  settings: Settings
  info: AppInfo
  tools: MediaToolsStatus | null
  folders: WatchFolderStatus[] | null
  projects: Project[]
  onRecheckTools: () => Promise<MediaToolsStatus>
  onSettingsChanged: (s: Settings) => void
  onInfoChanged: () => Promise<void>
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const SWATCHES = ['#3d8bfd', '#e8a33d', '#e2604a', '#4fb38a', '#a77be0', '#d9d9d9']
const SCAN_INTERVALS = [30, 60, 300, 900]

export function SettingsScreen({
  settings,
  info,
  tools,
  folders,
  projects,
  onRecheckTools,
  onSettingsChanged,
  onInfoChanged,
  onNotice,
  onError
}: Props) {
  const [accent, setAccent] = useState(settings.accentColor)
  const [checkingTools, setCheckingTools] = useState(false)

  async function recheckTools() {
    setCheckingTools(true)
    try {
      const status = await onRecheckTools()
      onNotice(status.ok ? { tone: 'success', text: 'O FFmpeg está funcionando.' } : { tone: 'error', text: status.message })
    } catch (e) {
      onError(e)
    } finally {
      setCheckingTools(false)
    }
  }
  const [pendingRoot, setPendingRoot] = useState<string | null>(null)
  const [encoder, setEncoder] = useState<EncoderInfo | null>(null)

  useEffect(() => {
    unwrap(api.editor.encoder()).then(setEncoder, () => setEncoder(null))
  }, [])

  async function updateSetting(patch: SettingsUpdateInput) {
    try {
      onSettingsChanged(await unwrap(api.settings.update(patch)))
    } catch (e) {
      onError(e)
    }
  }

  useEffect(() => setAccent(settings.accentColor), [settings.accentColor])

  // Preview immediately, persist once the user stops picking (the color picker fires on every drag step).
  useEffect(() => {
    if (!HEX_COLOR.test(accent)) return
    document.documentElement.style.setProperty('--accent', accent)
    if (accent.toLowerCase() === settings.accentColor.toLowerCase()) return
    const timer = window.setTimeout(() => {
      unwrap(api.settings.update({ accentColor: accent }))
        .then(onSettingsChanged)
        .catch(onError)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [accent, settings.accentColor, onSettingsChanged, onError])

  async function changeDataFolder() {
    try {
      const result = await unwrap(api.settings.chooseDataDirectory())
      if (result.changed) {
        setPendingRoot(result.path)
        onNotice({ tone: 'info', text: 'Pasta de dados salva. Reinicie o app para passar a usá-la.' })
      }
    } catch (e) {
      onError(e)
    }
  }

  async function changeExportFolder() {
    try {
      const result = await unwrap(api.settings.chooseExportDirectory())
      if (result.changed) {
        onSettingsChanged(await unwrap(api.settings.get()))
        await onInfoChanged()
        onNotice({ tone: 'success', text: 'Pasta de exportação atualizada.' })
      }
    } catch (e) {
      onError(e)
    }
  }

  async function openLogs() {
    try {
      await unwrap(api.app.openLogsFolder())
    } catch (e) {
      onError(e)
    }
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Preferências</p>
          <h1>Configurações</h1>
        </div>
      </header>

      <WatchFoldersPanel folders={folders} projects={projects} toolsReady={tools?.ok === true} onNotice={onNotice} onError={onError} />

      <section className="panel">
        <div className="panel-head">
          <h2>Funcionamento em segundo plano</h2>
        </div>
        <div className="setting">
          <div>
            <h3>Continuar na área de notificação ao fechar</h3>
            <p className="muted small">
              Fechar a janela mantém a Social Machine monitorando as pastas pelo ícone perto do relógio. Para encerrar de
              vez, use “Sair” nesse ícone. Com o app encerrado ou o computador desligado, nada é monitorado; ao abrir de
              novo, as pastas são verificadas e os vídeos criados nesse intervalo são importados.
            </p>
            {!info.trayAvailable && (
              <p className="hint">A área de notificação não está disponível nesta sessão: fechar a janela encerra o app.</p>
            )}
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.minimizeToTray}
              onChange={(e) => updateSetting({ minimizeToTray: e.target.checked })}
              data-testid="setting-tray"
            />
            <span>{settings.minimizeToTray ? 'Ligado' : 'Desligado'}</span>
          </label>
        </div>
        <div className="setting">
          <div>
            <h3>Iniciar com o Windows</h3>
            <p className="muted small">Abre minimizado na área de notificação quando você entra no Windows.</p>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(e) => updateSetting({ launchAtLogin: e.target.checked })}
              data-testid="setting-login"
            />
            <span>{settings.launchAtLogin ? 'Ligado' : 'Desligado'}</span>
          </label>
        </div>
        <div className="setting">
          <div>
            <h3>Varredura completa das pastas</h3>
            <p className="muted small">
              Rede de segurança caso o Windows não avise sobre algum arquivo novo. Arquivos novos costumam ser detectados
              na hora.
            </p>
          </div>
          <select
            value={settings.watchScanIntervalSeconds}
            onChange={(e) => updateSetting({ watchScanIntervalSeconds: Number(e.target.value) })}
            aria-label="Intervalo da varredura"
          >
            {[...new Set([...SCAN_INTERVALS, settings.watchScanIntervalSeconds])]
              .sort((a, b) => a - b)
              .map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `A cada ${s} s` : `A cada ${s / 60} min`}
                </option>
              ))}
          </select>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Armazenamento</h2>
        </div>
        <div className="setting">
          <div>
            <h3>Pasta de dados</h3>
            <p className="muted small">
              Banco de dados, miniaturas, versões e logs. Seus vídeos originais continuam onde estão.
            </p>
            <code className="path">{info.rootDirectory}</code>
            {pendingRoot && (
              <p className="hint">
                Depois de reiniciar, o app usará <code>{pendingRoot}</code>. Os dados atuais não são movidos: copie a
                pasta atual para lá antes, se quiser manter seus projetos.
              </p>
            )}
            {info.rootDirectoryOverridden && (
              <p className="hint">Definida pela variável de ambiente SM_DATA_DIR, por isso não pode ser mudada aqui.</p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={changeDataFolder}
            disabled={info.rootDirectoryOverridden}
          >
            Mudar…
          </button>
        </div>
        <div className="setting">
          <div>
            <h3>Pasta de exportação</h3>
            <p className="muted small">Onde as versões exportadas são gravadas, numa subpasta por projeto.</p>
            <code className="path">{info.exportDirectory}</code>
          </div>
          <button type="button" className="btn btn-ghost" onClick={changeExportFolder}>
            Mudar…
          </button>
        </div>
        <div className="setting">
          <div>
            <h3>Codificador de vídeo</h3>
            <p className="muted small">
              Automático usa a placa de vídeo (NVIDIA, Intel ou AMD) quando ela funciona, e o OpenH264 quando não há. Se uma
              exportação sair com problema, force o OpenH264.
            </p>
            {encoder && <p className="hint">Em uso nesta máquina: {encoder.label}</p>}
          </div>
          <select
            value={settings.encoderPreference}
            onChange={async (e) => {
              await updateSetting({ encoderPreference: e.target.value as 'auto' | 'software' })
              unwrap(api.editor.encoder()).then(setEncoder, () => setEncoder(null))
            }}
            aria-label="Codificador de vídeo"
          >
            <option value="auto">Automático</option>
            <option value="software">Sempre OpenH264 (software)</option>
          </select>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Aparência</h2>
        </div>
        <div className="setting">
          <div>
            <h3>Cor de destaque</h3>
            <p className="muted small">Usada em destaques e ações principais.</p>
            <div className="swatches" role="radiogroup" aria-label="Cor de destaque">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={accent.toLowerCase() === c}
                  aria-label={c}
                  className={`swatch${accent.toLowerCase() === c ? ' is-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setAccent(c)}
                />
              ))}
              <label className="swatch-custom">
                <input
                  type="color"
                  value={HEX_COLOR.test(accent) ? accent : settings.accentColor}
                  onChange={(e) => setAccent(e.target.value)}
                  aria-label="Cor personalizada"
                />
                Outra
              </label>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Diagnóstico</h2>
        </div>
        <dl className="facts">
          <div>
            <dt>Versão</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>FFmpeg</dt>
            <dd data-testid="ffmpeg-status">
              {!tools && 'Verificando…'}
              {tools?.ok && (
                <>
                  {tools.ffmpegVersion}
                  {tools.license && <span className="muted"> · {tools.license}</span>}
                  {tools.source !== 'packaged' && <span className="muted"> · {tools.source}</span>}
                </>
              )}
              {tools && !tools.ok && <span className="form-error">{tools.message}</span>}
            </dd>
          </div>
          {tools && (
            <div>
              <dt>Pasta do FFmpeg</dt>
              <dd>
                <code className="path">{tools.directory}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>Esquema do banco</dt>
            <dd>v{info.schemaVersion}</dd>
          </div>
          <div>
            <dt>Banco de dados</dt>
            <dd>
              <code className="path">{info.databasePath}</code>
            </dd>
          </div>
        </dl>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={openLogs}>
            Abrir pasta de logs
          </button>
          <button type="button" className="btn btn-ghost" onClick={recheckTools} disabled={checkingTools}>
            {checkingTools ? 'Verificando o FFmpeg…' : 'Verificar o FFmpeg de novo'}
          </button>
        </div>
        <p className="muted small">
          O FFmpeg acompanha o app sob a licença GNU LGPL v3. A licença, os avisos e as informações do código-fonte estão
          na pasta do FFmpeg mostrada acima.
        </p>
      </section>
    </div>
  )
}

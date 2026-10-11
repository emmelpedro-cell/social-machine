import { editorialState } from '../../shared/media'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppInfo, CreateProjectInput, Project, Settings, UpdateProjectInput } from '../../shared/schemas'
import { api, errorMessage, unwrap } from './api'
import { ProjectDialog } from './components/ProjectDialog'
import { Sidebar, type ScreenId } from './components/Sidebar'
import { Notice, type NoticeState } from './components/Notice'
import { DropOverlay } from './components/media/DropOverlay'
import { importNotice } from './media/format'
import { useMediaLibrary } from './media/useMediaLibrary'
import { useWatchFolders } from './watch/useWatchFolders'
import { DashboardScreen } from './screens/DashboardScreen'
import { LibraryScreen, type LibraryFilters } from './screens/LibraryScreen'
import { ProjectsScreen } from './screens/ProjectsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { EditorScreen } from './screens/EditorScreen'
import { AccountsScreen } from './screens/AccountsScreen'
import { QueueScreen } from './screens/QueueScreen'
import { AnalyticsScreen } from './screens/AnalyticsScreen'
import { CalendarScreen } from './screens/CalendarScreen'
import { useAttentionCount } from './queue/useAttention'
import { InboxScreen } from './screens/InboxScreen'
import { useInboxUnread } from './inbox/useInbox'
import { useVersionCounts } from './editor/useVersions'
import type { EditSettings } from '../../shared/editor'

const DEFAULT_FILTERS: LibraryFilters = { project: 'all', workflow: 'active' }

export function App() {
  const [screen, setScreen] = useState<ScreenId>('dashboard')
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [dialog, setDialog] = useState<{ project?: Project } | null>(null)
  const [libraryFilters, setLibraryFilters] = useState<{ filters: LibraryFilters; key: number }>({
    filters: DEFAULT_FILTERS,
    key: 0
  })
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const showError = useCallback((error: unknown) => setNotice({ tone: 'error', text: errorMessage(error) }), [])
  const dismissNotice = useCallback(() => setNotice(null), [])
  const library = useMediaLibrary(
    useCallback(
      (fileName: string, existing: string) =>
        setNotice({ tone: 'info', text: `“${fileName}” não foi adicionado: o mesmo vídeo já está na biblioteca como “${existing}”.` }),
      []
    )
  )
  const watch = useWatchFolders()
  const versionCounts = useVersionCounts()
  const attention = useAttentionCount()
  const inboxUnread = useInboxUnread()
  const [analyticsContent, setAnalyticsContent] = useState<{ id: string | null; key: number }>({ id: null, key: 0 })

  function openAnalytics(contentId: string | null) {
    setAnalyticsContent((c) => ({ id: contentId, key: c.key + 1 }))
    setScreen('analytics')
  }
  const [editor, setEditor] = useState<{ contentId: string | null; settings: EditSettings | null; key: number }>({
    contentId: null,
    settings: null,
    key: 0
  })

  function openEditor(contentId: string, settings?: EditSettings) {
    setEditor((current) => ({ contentId: contentId || null, settings: settings ?? null, key: current.key + 1 }))
    setScreen('editor')
  }

  const refreshProjects = useCallback(async () => {
    setProjects(await unwrap(api.projects.list()))
  }, [])

  const refreshInfo = useCallback(async () => {
    setInfo(await unwrap(api.app.getInfo()))
  }, [])

  useEffect(() => {
    Promise.all([unwrap(api.projects.list()), unwrap(api.settings.get()), unwrap(api.app.getInfo())])
      .then(([p, s, i]) => {
        setProjects(p)
        setSettings(s)
        setInfo(i)
      })
      .catch((error: unknown) => setLoadError(errorMessage(error)))
  }, [])

  useEffect(() => {
    if (settings) document.documentElement.style.setProperty('--accent', settings.accentColor)
  }, [settings])

  const needsReview = useMemo(
    () => library.assets?.filter((a) => editorialState(a) === 'needs_review').length ?? 0,
    [library.assets]
  )

  function openLibrary(filters: LibraryFilters) {
    // A new key remounts the library with these filters.
    setLibraryFilters((current) => ({ filters, key: current.key + 1 }))
    setScreen('library')
  }

  async function submitProject(input: CreateProjectInput | UpdateProjectInput) {
    if ('id' in input) {
      const project = await unwrap(api.projects.update(input))
      setNotice({ tone: 'success', text: `Projeto “${project.name}” salvo.` })
    } else {
      const project = await unwrap(api.projects.create(input))
      setNotice({ tone: 'success', text: `Projeto “${project.name}” criado.` })
    }
    await refreshProjects()
    setDialog(null)
  }

  async function importDropped(files: File[]) {
    // Dropped videos arrive without a project; assign them from the library (one or many at once).
    if (screen !== 'library') openLibrary(DEFAULT_FILTERS)
    try {
      const summary = await unwrap(api.media.importDropped(files, null))
      const n = importNotice(summary)
      if (n) setNotice(n)
    } catch (error) {
      showError(error)
    }
  }

  if (loadError) {
    return (
      <div className="fatal">
        <h1>O app não conseguiu carregar os dados</h1>
        <p>{loadError}</p>
        <p className="muted">Veja o arquivo de log na pasta app-data/logs e reinicie o app.</p>
      </div>
    )
  }

  const projectList = projects ?? []

  return (
    <div className="shell">
      <Sidebar
        current={screen}
        onNavigate={(id) => (id === 'library' ? openLibrary(DEFAULT_FILTERS) : id === 'analytics' ? openAnalytics(null) : setScreen(id))}
        version={info?.version}
        needsReview={needsReview}
        attention={attention}
        inboxUnread={inboxUnread}
      />
      <main className="main" aria-live="polite">
        {screen === 'dashboard' && (
          <DashboardScreen
            projects={projects}
            assets={library.assets}
            folders={watch.folders}
            toolsOk={library.tools ? library.tools.ok : null}
            onOpenLibrary={openLibrary}
            onOpenProjects={() => setScreen('projects')}
            onOpenSettings={() => setScreen('settings')}
            onOpenQueue={() => setScreen('queue')}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'library' && (
          <LibraryScreen
            key={libraryFilters.key}
            library={library}
            projects={projectList}
            initialFilters={libraryFilters.filters}
            versionCounts={versionCounts}
            onOpenEditor={openEditor}
            onOpenAccounts={() => setScreen('accounts')}
            onOpenAnalytics={(id) => openAnalytics(id)}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'projects' && (
          <ProjectsScreen
            projects={projects}
            assets={library.assets}
            folders={watch.folders}
            onNewProject={() => setDialog({})}
            onEditProject={(project) => setDialog({ project })}
            onOpenLibrary={(projectId) => openLibrary({ project: projectId, workflow: 'active' })}
            onChanged={async () => {
              await refreshProjects()
              await library.reload()
              await watch.reload()
            }}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'editor' && (
          <EditorScreen
            key={editor.key}
            content={library.assets?.find((a) => a.id === editor.contentId) ?? null}
            initialSettings={editor.settings}
            assets={library.assets}
            projects={projectList}
            onOpen={openEditor}
            onOpenAccounts={() => setScreen('accounts')}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'queue' && (
          <QueueScreen projects={projectList} onOpenCalendar={() => setScreen('calendar')} onNotice={setNotice} onError={showError} />
        )}
        {screen === 'calendar' && (
          <CalendarScreen projects={projectList} onOpenQueue={() => setScreen('queue')} onNotice={setNotice} onError={showError} />
        )}
        {screen === 'analytics' && (
          <AnalyticsScreen
            key={analyticsContent.key}
            projects={projectList}
            contentId={analyticsContent.id}
            onOpenContent={(id) => setAnalyticsContent((c) => ({ id, key: c.key }))}
            onOpenAccounts={() => setScreen('accounts')}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'accounts' && <AccountsScreen projects={projectList} onNotice={setNotice} onError={showError} />}
        {screen === 'inbox' && (
          <InboxScreen
            projects={projectList}
            onOpenContent={(id) => openAnalytics(id)}
            onOpenAccounts={() => setScreen('accounts')}
            onNotice={setNotice}
            onError={showError}
          />
        )}
        {screen === 'settings' && settings && info && (
          <SettingsScreen
            settings={settings}
            info={info}
            tools={library.tools}
            folders={watch.folders}
            projects={projectList}
            onRecheckTools={library.recheckTools}
            onSettingsChanged={setSettings}
            onInfoChanged={refreshInfo}
            onNotice={setNotice}
            onError={showError}
          />
        )}
      </main>
      <DropOverlay enabled={library.tools?.ok === true} onDrop={importDropped} />
      {dialog && <ProjectDialog project={dialog.project} onCancel={() => setDialog(null)} onSubmit={submitProject} />}
      {notice && <Notice notice={notice} onDismiss={dismissNotice} />}
    </div>
  )
}

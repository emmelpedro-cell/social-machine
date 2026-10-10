import type { IpcMain } from 'electron'
import type { IpcChannel } from '../../shared/channels'
import type { Logger } from '../logger'
import { wrapHandler } from './handler'
import type { HandlerTable } from './handlers'

/** Registers every handler with ipcMain, rejecting calls that don't come from our renderer. */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  table: HandlerTable,
  isTrustedSender: (frameUrl: string | undefined | null) => boolean,
  logger: Logger
): void {
  for (const [channel, definition] of Object.entries(table) as [IpcChannel, HandlerTable[IpcChannel]][]) {
    const run = wrapHandler(channel, definition, logger)
    ipcMain.handle(channel, async (event, rawInput: unknown) => {
      const frameUrl = event.senderFrame?.url
      if (!isTrustedSender(frameUrl)) {
        logger.warn('Blocked IPC call from untrusted frame', { channel, frameUrl })
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Request rejected.' } }
      }
      return run(rawInput)
    })
  }
}

import { createContext, useContext } from 'react'

export interface Capabilities {
  supportedRoutes: string[]
  templates?: boolean
  notifications?: boolean
  actions?: boolean
  recurringMaintenance?: boolean
  dependencies?: boolean
  runNow?: boolean
  monitorModal?: boolean
  monitorAuth?: boolean
  incidentDelete?: boolean
}

export const CapabilitiesContext = createContext<Capabilities>({ supportedRoutes: [] })
export const useCapabilities = () => useContext(CapabilitiesContext)

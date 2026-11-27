import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {render,screen,waitFor,within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ApiError} from '@better-forge/ui'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {api} from '../api/client'
import {CapabilitiesContext} from '../capabilities'
import CloudflareActions from './CloudflareActions'
import { MemoryRouter } from 'react-router-dom'
vi.mock('../api/client',()=>({api:{get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}}))
const checkId='00000000-0000-4000-8000-000000000001'
const action={id:'00000000-0000-4000-8000-000000000002',name:'Recover',endpointId:'approved',vaultId:1,secretId:2,enabled:1,version:3,checkIds:[checkId],triggerStatus:'down'}
function setup(client=new QueryClient({defaultOptions:{queries:{retry:false}}}),supportedRoutes=['/admin/delivery-history']){render(<MemoryRouter><QueryClientProvider client={client}><CapabilitiesContext.Provider value={{supportedRoutes}}><CloudflareActions /></CapabilitiesContext.Provider></QueryClientProvider></MemoryRouter>);return userEvent.setup()}
beforeEach(()=>{
 vi.resetAllMocks()
 vi.mocked(api.get).mockImplementation(async path=>{
  if(path==='/admin/actions') return [action]
  if(path==='/admin/actions/destinations') return [{id:'approved',name:'Approved action'}]
  if(path==='/admin/actions/checks') return [{id:checkId,name:'Service',componentId:'component',configVersion:7}]
  if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
  if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'},{id:3,name:'Login',type:'userpass'}]
  return []
 })
})
describe('Cloudflare actions',()=>{
 it('warns when the isolated fixture destination is configured',async()=>{
  vi.mocked(api.get).mockImplementation(async path=>path==='/admin/actions/destinations'?[{id:'issue14-isolated-sink',name:'Issue 14 isolated sink'}]:[])
  setup()
  expect(await screen.findByText(/Isolated preview for editor testing only/)).toHaveTextContent('Actions do not execute here')
  expect(screen.getByText(/Isolated preview for editor testing only/)).toHaveTextContent('do not enter real secrets')
 })
 it('saves only a Vault reference, approved target and monitor trigger',async()=>{
  const user=setup();await user.click(await screen.findByRole('button',{name:'Add Action'}));const form=screen.getByRole('dialog')
  await user.type(within(form).getByLabelText('Action name'),'Recover service')
  await user.selectOptions(await within(form).findByLabelText('Approved action destination'),'approved')
  await user.selectOptions(await within(form).findByLabelText('Vault'),'1')
  expect(await within(form).findByRole('option',{name:'Token'})).toBeInTheDocument()
  expect(within(form).queryByRole('option',{name:'Login'})).not.toBeInTheDocument()
  await user.selectOptions(within(form).getByLabelText('Secure Value secret'),'2')
  await user.selectOptions(within(form).getByLabelText('Trigger on'),'degraded')
  await user.click(await within(form).findByRole('checkbox',{name:'Service'}))
  vi.mocked(api.post).mockResolvedValueOnce({})
  await user.click(within(form).getByRole('button',{name:'Create Action'}))
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/admin/actions',{name:'Recover service',endpointId:'approved',vaultId:1,secretId:2,enabled:true,checkIds:[checkId],checkSnapshots:[{id:checkId,componentId:'component',configVersion:7}],triggerStatus:'degraded'}))
 })
 it('deletes only the displayed version and offers no manual execution',async()=>{
  const user=setup();await screen.findByText('Recover')
  expect(screen.queryByRole('button',{name:/test|run now/i})).not.toBeInTheDocument()
  await user.click(screen.getByRole('button',{name:'Delete action Recover'}));vi.mocked(api.delete).mockResolvedValueOnce(undefined)
  await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete'}))
  await waitFor(()=>expect(api.delete).toHaveBeenCalledWith(`/admin/actions/${action.id}`,{version:3}))
 })
 it('shows the approved destination and links to action history', async () => {
  setup()
  expect(await screen.findByText('HTTP POST · Approved action')).toBeInTheDocument()
  expect(screen.getByRole('link', {name:'Run history'})).toHaveAttribute('href', '/admin/delivery-history?tab=actions')
 })
 it('hides action history when the capability is unavailable', async () => {
  setup(undefined,[])
  expect(await screen.findByText('HTTP POST · Approved action')).toBeInTheDocument()
  expect(screen.queryByRole('link',{name:'Run history'})).not.toBeInTheDocument()
 })
 it('prevents edits and closing while an action save is pending', async () => {
  const user=setup()
  await user.click(await screen.findByRole('button',{name:'Edit'}))
  const form=screen.getByRole('dialog')
  await waitFor(()=>expect(within(form).getByRole('button',{name:'Save Action'})).toBeEnabled())
  let finish!: (value: unknown) => void
  vi.mocked(api.patch).mockReturnValueOnce(new Promise(resolve => { finish=resolve }))
  await user.click(within(form).getByRole('button',{name:'Save Action'}))
  expect(within(form).getByLabelText('Action name')).toBeDisabled()
  expect(within(form).getByRole('button',{name:'Cancel'})).toBeDisabled()
  expect(within(form).getByRole('button',{name:'Save Action'})).toBeDisabled()
  finish({})
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
 })
 it('keeps the selected monitor snapshot if choices refresh while editing',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=setup(client)
  await user.click(await screen.findByRole('button',{name:'Edit'}));const form=screen.getByRole('dialog')
  await waitFor(()=>expect(within(form).getByRole('checkbox',{name:'Service'})).toBeChecked())
  await waitFor(()=>expect(within(form).getByRole('button',{name:'Save Action'})).toBeEnabled())
  client.setQueryData(['worker-action-checks'],[{id:checkId,name:'Moved service',componentId:'other',configVersion:8}])
  await within(form).findByRole('checkbox',{name:'Moved service'})
  vi.mocked(api.patch).mockRejectedValueOnce(new Error('Conflict'))
  await user.click(within(form).getByRole('button',{name:'Save Action'}))
  await waitFor(()=>expect(api.patch).toHaveBeenCalledWith(`/admin/actions/${action.id}`,expect.objectContaining({version:3,checkIds:[checkId],checkSnapshots:[{id:checkId,componentId:'component',configVersion:7}]})))
  expect(await within(form).findByRole('alert')).toHaveTextContent('Could not save action')
 })
 it.each([
  {error:new ApiError('Monitor choices are out of date. Refresh the page and try again.',409),expected:'Monitor choices are out of date. Refresh the page and try again.'},
  {error:new ApiError('private provider details',409),expected:'Could not save action.'},
  {error:new ApiError('Monitor choices are out of date. Refresh the page and try again.',500),expected:'Could not save action.'},
 ])('shows only the known refresh conflict',async({error,expected})=>{
  const user=setup();await user.click(await screen.findByRole('button',{name:'Edit'}));const form=screen.getByRole('dialog')
  await waitFor(()=>expect(within(form).getByRole('button',{name:'Save Action'})).toBeEnabled())
  vi.mocked(api.patch).mockRejectedValueOnce(error)
  await user.click(within(form).getByRole('button',{name:'Save Action'}))
  expect(await within(form).findByRole('alert')).toHaveTextContent(expected)
  expect(within(form).getByRole('alert')).not.toHaveTextContent('private provider details')
 })
})

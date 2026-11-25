import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {render,screen,waitFor,within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {api} from '../api/client'
import CloudflareActions from './CloudflareActions'
vi.mock('../api/client',()=>({api:{get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}}))
const checkId='00000000-0000-4000-8000-000000000001'
const action={id:'00000000-0000-4000-8000-000000000002',name:'Recover',endpointId:'approved',vaultId:1,secretId:2,enabled:1,version:3,checkIds:[checkId],triggerStatus:'down'}
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><CloudflareActions /></QueryClientProvider>);return userEvent.setup()}
beforeEach(()=>{
 vi.resetAllMocks()
 vi.mocked(api.get).mockImplementation(async path=>{
  if(path==='/admin/actions') return [action]
  if(path==='/admin/actions/destinations') return [{id:'approved',name:'Approved action'}]
  if(path==='/admin/actions/checks') return [{id:checkId,name:'Service'}]
  if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
  if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'},{id:3,name:'Login',type:'userpass'}]
  return []
 })
})
describe('Cloudflare actions',()=>{
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
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/admin/actions',{name:'Recover service',endpointId:'approved',vaultId:1,secretId:2,enabled:true,checkIds:[checkId],triggerStatus:'degraded'}))
 })
 it('deletes only the displayed version and offers no manual execution',async()=>{
  const user=setup();await screen.findByText('Recover')
  expect(screen.queryByRole('button',{name:/test|run now/i})).not.toBeInTheDocument()
  await user.click(screen.getByRole('button',{name:'Delete action Recover'}));vi.mocked(api.delete).mockResolvedValueOnce(undefined)
  await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete'}))
  await waitFor(()=>expect(api.delete).toHaveBeenCalledWith(`/admin/actions/${action.id}`,{version:3}))
 })
})

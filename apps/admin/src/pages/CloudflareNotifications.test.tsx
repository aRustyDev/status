import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '@better-forge/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareNotifications from './CloudflareNotifications'

vi.mock('../api/client',()=>({api:{get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}}))
const checkId='00000000-0000-4000-8000-000000000001'
const channel={id:'00000000-0000-4000-8000-000000000002',name:'Alerts',endpointId:'approved',vaultId:1,secretId:2,enabled:1,version:3,checkIds:[checkId]}
function setup(client=new QueryClient({defaultOptions:{queries:{retry:false}}})){render(<QueryClientProvider client={client}><CloudflareNotifications /></QueryClientProvider>);return userEvent.setup()}
beforeEach(()=>{
  vi.resetAllMocks()
  vi.mocked(api.get).mockImplementation(async path=>{
    if(path==='/admin/notifications/channels') return [channel]
    if(path==='/admin/notifications/destinations') return [{id:'approved',name:'Approved webhook'}]
    if(path==='/admin/notifications/checks') return [{id:checkId,name:'Service',componentId:'component',version:7}]
    if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
    if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'},{id:3,name:'Login',type:'userpass'}]
    return []
  })
})
describe('Cloudflare notification channels',()=>{
  it('describes first-observation alert behavior accurately',async()=>{
    setup()
    expect(await screen.findByText(/first unhealthy monitor result can send an alert/)).toHaveTextContent('a first healthy result establishes a baseline')
    expect(screen.queryByText(/Initial monitor results do not send an alert/)).not.toBeInTheDocument()
  })
  it('creates a webhook using only a Vault Secure Value and selected local monitor',async()=>{
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Add Channel'}))
    const form=screen.getByRole('dialog')
    await user.type(within(form).getByLabelText('Channel name'),'New alerts')
    await user.selectOptions(await within(form).findByLabelText('Approved webhook destination'),'approved')
    await user.selectOptions(await within(form).findByLabelText('Vault'),'1')
    expect(await within(form).findByRole('option',{name:'Token'})).toBeInTheDocument()
    expect(within(form).queryByRole('option',{name:'Login'})).not.toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('Secure Value secret'),'2')
    await user.click(await within(form).findByRole('checkbox',{name:'Service'}))
    vi.mocked(api.post).mockResolvedValueOnce({})
    await user.click(within(form).getByRole('button',{name:'Create Channel'}))
    await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/admin/notifications/channels',{name:'New alerts',endpointId:'approved',vaultId:1,secretId:2,enabled:true,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:'component',version:7}]}))
    expect(JSON.stringify(vi.mocked(api.post).mock.calls)).not.toMatch(/password|fixture-token/)
  })
  it('tests the saved version and reports only a generic error',async()=>{
    const user=setup(); await screen.findByText('Alerts')
    vi.mocked(api.post).mockRejectedValueOnce(new Error('secret response body'))
    await user.click(screen.getByRole('button',{name:'Send test'}))
    expect(await screen.findByRole('status')).toHaveTextContent('Test failed')
    expect(screen.getByRole('status')).not.toHaveTextContent('secret response body')
    expect(api.post).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}/test`,{version:3})
  })
  it('deletes only the displayed version',async()=>{
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Delete channel Alerts'}))
    vi.mocked(api.delete).mockResolvedValueOnce(undefined)
    await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete'}))
    await waitFor(()=>expect(api.delete).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,{version:3}))
  })
  it('keeps the selected monitor snapshot if choices refresh while editing',async()=>{
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=setup(client)
    await user.click(await screen.findByRole('button',{name:'Edit'}));const form=screen.getByRole('dialog')
    await waitFor(()=>expect(within(form).getByRole('checkbox',{name:'Service'})).toBeChecked())
    await waitFor(()=>expect(within(form).getByRole('button',{name:'Save Channel'})).toBeEnabled())
    client.setQueryData(['worker-channel-checks'],[{id:checkId,name:'Moved service',componentId:'other',version:8}])
    await within(form).findByRole('checkbox',{name:'Moved service'})
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('Conflict'))
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    await waitFor(()=>expect(api.patch).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,expect.objectContaining({version:3,checkIds:[checkId],expectedChecks:[{id:checkId,componentId:'component',version:7}]})))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not save channel')
  })
  it.each([
    {error:new ApiError('Monitor choices are out of date. Refresh the page and try again.',409),expected:'Monitor choices are out of date. Refresh the page and try again.'},
    {error:new ApiError('private provider details',409),expected:'Could not save channel.'},
    {error:new ApiError('Monitor choices are out of date. Refresh the page and try again.',500),expected:'Could not save channel.'},
  ])('shows only the known refresh conflict',async({error,expected})=>{
    const user=setup();await user.click(await screen.findByRole('button',{name:'Edit'}));const form=screen.getByRole('dialog')
    await waitFor(()=>expect(within(form).getByRole('button',{name:'Save Channel'})).toBeEnabled())
    vi.mocked(api.patch).mockRejectedValueOnce(error)
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    expect(await within(form).findByRole('alert')).toHaveTextContent(expected)
    expect(within(form).getByRole('alert')).not.toHaveTextContent('private provider details')
  })
})

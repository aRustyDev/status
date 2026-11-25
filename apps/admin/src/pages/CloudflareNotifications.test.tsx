import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import CloudflareNotifications from './CloudflareNotifications'

vi.mock('../api/client',()=>({api:{get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}}))
const checkId='00000000-0000-4000-8000-000000000001'
const componentId='00000000-0000-4000-8000-000000000003'
const checkSnapshot={id:checkId,componentId,version:2}
const channel={id:'00000000-0000-4000-8000-000000000002',name:'Alerts',endpointId:'approved',vaultId:1,secretId:2,enabled:1,version:3,associationVersion:2,checkIds:[checkId]}
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><CloudflareNotifications /></QueryClientProvider>);return userEvent.setup()}
beforeEach(()=>{
  vi.resetAllMocks()
  vi.mocked(api.get).mockImplementation(async path=>{
    if(path==='/admin/notifications/channels') return [channel]
    if(path==='/admin/notifications/destinations') return [{id:'approved',name:'Approved webhook'}]
    if(path==='/admin/notifications/email-destinations') return [{id:'ops-mail',name:'Operations inbox'}]
    if(path==='/admin/notifications/checks') return [{...checkSnapshot,name:'Service'}]
    if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
    if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'},{id:3,name:'Login',type:'userpass'}]
    return []
  })
})
describe('Cloudflare notification channels',()=>{
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
    await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/admin/notifications/channels',{name:'New alerts',endpointId:'approved',vaultId:1,secretId:2,enabled:true,checkIds:[checkId],expectedChecks:[checkSnapshot]}))
    expect(JSON.stringify(vi.mocked(api.post).mock.calls)).not.toMatch(/password|fixture-token/)
  })

  it('creates an email channel using an approved recipient without Vault credentials',async()=>{
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Add Channel'}))
    const form=screen.getByRole('dialog')
    await user.type(within(form).getByLabelText('Channel name'),'Email alerts')
    await user.selectOptions(within(form).getByLabelText('Channel type'),'email')
    await user.selectOptions(await within(form).findByLabelText('Approved email recipient'),'ops-mail')
    expect(within(form).queryByLabelText('Vault')).not.toBeInTheDocument()
    await user.click(await within(form).findByRole('checkbox',{name:'Service'}))
    vi.mocked(api.post).mockResolvedValueOnce({})
    await user.click(within(form).getByRole('button',{name:'Create Channel'}))
    await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/admin/notifications/channels',{name:'Email alerts',type:'email',recipientId:'ops-mail',enabled:true,checkIds:[checkId],expectedChecks:[checkSnapshot]}))
  })
  it('shows unavailable email recipients without silently allowing a save',async()=>{
    vi.mocked(api.get).mockImplementation(async path=>{
      if(path==='/admin/notifications/channels') return [channel]
      if(path==='/admin/notifications/checks') return []
      if(path==='/admin/notifications/email-destinations') throw new Error('Unavailable')
      return []
    })
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Add Channel'}))
    const form=screen.getByRole('dialog')
    await user.type(within(form).getByLabelText('Channel name'),'Email alerts')
    await user.selectOptions(within(form).getByLabelText('Channel type'),'email')
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not load approved email recipients')
    expect(within(form).getByRole('button',{name:'Create Channel'})).toBeDisabled()
  })
  it('edits an email channel using its original version',async()=>{
    vi.mocked(api.get).mockImplementation(async path=>{
      if(path==='/admin/notifications/channels') return [{id:channel.id,name:'Mail',type:'email',recipientId:'ops-mail',enabled:1,version:4,associationVersion:5,checkIds:[]}]
      if(path==='/admin/notifications/email-destinations') return [{id:'ops-mail',name:'Operations inbox'}]
      return []
    })
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Edit'}))
    const form=screen.getByRole('dialog')
    expect(within(form).getByLabelText('Channel type')).toHaveValue('email')
    expect(await within(form).findByRole('option',{name:'Operations inbox'})).toBeInTheDocument()
    await user.clear(within(form).getByLabelText('Channel name')); await user.type(within(form).getByLabelText('Channel name'),'Renamed mail')
    vi.mocked(api.patch).mockResolvedValueOnce({})
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    await waitFor(()=>expect(api.patch).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,{name:'Renamed mail',type:'email',recipientId:'ops-mail',enabled:true,checkIds:[],expectedChecks:[],version:4,expectedCheckIds:[],expectedAssociationVersion:5}))
  })
  it('tests the saved version and reports only a generic error',async()=>{
    const user=setup(); await screen.findByText('Alerts')
    vi.mocked(api.post).mockRejectedValueOnce(new Error('secret response body'))
    await user.click(screen.getByRole('button',{name:'Send test'}))
    expect(await screen.findByRole('status')).toHaveTextContent('Test failed')
    expect(screen.getByRole('status')).not.toHaveTextContent('secret response body')
    expect(api.post).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}/test`,{version:3})
  })

  it('keeps the channel draft and original association snapshot after a conflict',async()=>{
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Edit'}))
    const form=screen.getByRole('dialog')
    await user.clear(within(form).getByLabelText('Channel name')); await user.type(within(form).getByLabelText('Channel name'),'Changed')
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('Conflict'))
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not save channel')
    expect(within(form).getByLabelText('Channel name')).toHaveValue('Changed')
    vi.mocked(api.patch).mockResolvedValueOnce({})
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    await waitFor(()=>expect(api.patch).toHaveBeenLastCalledWith(`/admin/notifications/channels/${channel.id}`,expect.objectContaining({name:'Changed',version:3,checkIds:[checkId],expectedChecks:[checkSnapshot],expectedCheckIds:[checkId],expectedAssociationVersion:2})))
  })

  it('retains the original association version while channel data refreshes',async()=>{
    const user=userEvent.setup()
    let current=channel
    vi.mocked(api.get).mockImplementation(async path=>{
      if(path==='/admin/notifications/channels') return [current]
      if(path==='/admin/notifications/destinations') return [{id:'approved',name:'Approved webhook'}]
      if(path==='/admin/notifications/checks') return [{...checkSnapshot,name:'Service'}]
      if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
      if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'}]
      return []
    })
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
    render(<QueryClientProvider client={client}><CloudflareNotifications /></QueryClientProvider>)
    await user.click(await screen.findByRole('button',{name:'Edit'}))
    const form=screen.getByRole('dialog')
    await within(form).findByRole('option',{name:'Token'})
    current={...channel,associationVersion:3}
    await act(async()=>{await client.refetchQueries({queryKey:['worker-channels']})})
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('Changed'))
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not save channel')
    expect(api.patch).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,expect.objectContaining({version:3,expectedAssociationVersion:2,expectedCheckIds:[checkId]}))
  })
  it('keeps the selected check identity and version when its catalog refreshes',async()=>{
    const user=userEvent.setup()
    let currentCheck={...checkSnapshot,name:'Service'}
    vi.mocked(api.get).mockImplementation(async path=>{
      if(path==='/admin/notifications/channels') return [channel]
      if(path==='/admin/notifications/destinations') return [{id:'approved',name:'Approved webhook'}]
      if(path==='/admin/notifications/checks') return [currentCheck]
      if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
      if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'}]
      return []
    })
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
    render(<QueryClientProvider client={client}><CloudflareNotifications /></QueryClientProvider>)
    await user.click(await screen.findByRole('button',{name:'Edit'}))
    const form=screen.getByRole('dialog')
    await within(form).findByRole('checkbox',{name:'Service'})
    expect(within(form).getByRole('checkbox',{name:'Service'})).toBeChecked()
    currentCheck={...currentCheck,componentId:'00000000-0000-4000-8000-000000000004',version:3,name:'Moved service'}
    await act(async()=>{await client.refetchQueries({queryKey:['worker-channel-checks']})})
    expect(await within(form).findByRole('checkbox',{name:'Moved service'})).toBeChecked()
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('Changed'))
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Could not save channel')
    expect(api.patch).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,expect.objectContaining({expectedChecks:[checkSnapshot]}))
  })

  it('requires removal of a selected check missing from the fresh catalog',async()=>{
    vi.mocked(api.get).mockImplementation(async path=>{
      if(path==='/admin/notifications/channels') return [channel]
      if(path==='/admin/notifications/destinations') return [{id:'approved',name:'Approved webhook'}]
      if(path==='/admin/notifications/checks') return []
      if(path==='/admin/vaults') return [{id:1,name:'Operations'}]
      if(path==='/admin/vaults/1/secrets') return [{id:2,name:'Token',type:'value'}]
      return []
    })
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Edit'}))
    const form=screen.getByRole('dialog')
    expect(await within(form).findByRole('alert')).toHaveTextContent('A selected monitor is unavailable')
    expect(within(form).getByRole('button',{name:'Save Channel'})).toBeDisabled()
    await user.click(within(form).getByRole('button',{name:'Remove unavailable monitor'}))
    vi.mocked(api.patch).mockResolvedValueOnce({})
    await user.click(within(form).getByRole('button',{name:'Save Channel'}))
    await waitFor(()=>expect(api.patch).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,expect.objectContaining({checkIds:[],expectedChecks:[],expectedCheckIds:[checkId]})))
  })

  it('deletes only the displayed version',async()=>{
    const user=setup(); await user.click(await screen.findByRole('button',{name:'Delete channel Alerts'}))
    vi.mocked(api.delete).mockResolvedValueOnce(undefined)
    await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete'}))
    await waitFor(()=>expect(api.delete).toHaveBeenCalledWith(`/admin/notifications/channels/${channel.id}`,{version:3,expectedAssociationVersion:2}))
  })
})

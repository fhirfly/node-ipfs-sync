import * as log from './logger'
import { Configuration } from './config'
import { HttpClient, HttpError } from './httpClient'
import { none, Option, some } from './result'

export default class EstuaryClient {
  private readonly hasApiKey: boolean
  private readonly http: HttpClient

  constructor(private readonly config: Configuration) {
    this.hasApiKey = !!config.estuaryApiKey
    this.http = new HttpClient('https://api.estuary.tech/', {
      'Authorization': `Bearer ${config.estuaryApiKey}`
    })
  }

  /** Add pin to the IPFS daemon. */
  async pin(cid: string, name: string): Promise<Option<HttpError>> {
    if (this.hasApiKey) {
      return some(HttpError.fromMessage('Missing Estuary API key.'))
    }

    const response = await this.http.post('pinning/pins', {
      body: { cid, name }
    })

    return response.ok ? none() : some(response.error)
  }

  async updatePin(oldcid: string, newCid: string, name: string): Promise<void> {
    const getPins = await this.http.get('pinning/pins', {
      query: { cid: oldcid }
    })

    if (!getPins.ok) {
      log.error('Error getting estuary pin', getPins.error)
      return
    }

    const pins = JSON.parse(getPins.value) as {
      count: number
      results: Array<{
        requestId: string
        pin: { cid: string }
      }>
    }

    // FIXME
    // Estuary doesn't seem to support `cid` GET field yet, so we need to
    // iterate through the results and find the target request id manually.
    // When Estuary supports the `cid` GET field this code can be removed.
    let pinId = ''
    for (const res of pins.results) {
      if (res.pin.cid === oldcid) {
        pinId = res.requestId
        break
      }
    }
    // END OF FIXME

    if (pinId) {
      // found the request id
      const replacePinResponse = await this.http.post(`pinning/pins/${pinId}`, {
        body: { cid: newCid, name }
      })

      if (replacePinResponse.ok) {
        // pin updated, exit early
        return
      }

      log.error('Error updating estuary pin', replacePinResponse.error)
    }

    const pinObjectError = await this.pin(newCid, name)
    if (pinObjectError.hasValue) {
      log.error('Error pinning to estuary', pinObjectError.value)
    }
  }
}

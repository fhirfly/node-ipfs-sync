import axios, { AxiosError, AxiosInstance, Method } from 'axios'
import { err, ok, Result } from './result'
import * as log from './logger'
import { Agent } from 'https'

export function parseJson(text: string): Record<string, any> {
  return JSON.parse(text, function (key, value) {
    const normalizedKey = key.substring(0, 1).toLowerCase() + key.slice(1)
    this[normalizedKey] = value
    return value
  })
}

/** Represents an error received by the IPFS daemon. */
export class HttpError {
  private constructor(
    public code: number,
    public type: string,
    /** Contains error text. */
    public message?: string,
    /** Contains error text. */
    public error?: string,
  ) {}

  static fromAxiosError(error: AxiosError) {
    if (error.response?.data) {
      return HttpError.fromJson(error.response.data as string)
    }

    return new HttpError(
      error.response?.status ?? -1,
      error.name,
      error.message,
      error.code,
    )
  }

  static fromError(error: Error) {
    return new HttpError(
      -1,
      error.name,
      error.message,
      error.stack,
    )
  }

  static fromMessage(message: string) {
    return new HttpError(
      -1,
      'Error',
      message,
      message,
    )
  }

  static fromJson(data: string) {
    const json = parseJson(data)
    return new HttpError(
      json['code'],
      json['type'],
      json['message'],
      json['error'],
    )
  }

  hasError() {
    return !!(this.message || this.error)
  }

  getError() {
    return this.message || this.error || ''
  }
}

export type RequestOptions = {
  /** Request timeout is ignored when `undefined` or `<= 0` */
  timeout?: number
  /** Key/value pairs to be appended to the URL as query. */
  query?: Record<string, any> | URLSearchParams
  /** Additional headers for the request. Overrides values of base client headers with the same keys.
  */
  headers?: Record<string, any>
  /** The body of the request.
   * Can be an object that will be serialized to JSON or
   * `FormData` for `mulitpart/form-data` requests.
   * `Content-Type` header is set automatically according to the data.
  */
  body?: Record<string, any> | typeof FormData
  /** Set to `true` to receive the response as a readable stream, instead of a text string. */
  streamResponse?: boolean
}

type HttpResponse<T> =
  T extends { streamResponse: true }
    ? Result<NodeJS.ReadableStream, HttpError>
    : Result<string, HttpError>

export class HttpClient {
  private readonly client: AxiosInstance

  constructor(baseURL: string, baseHeaders?: Record<string, any>) {
    this.client = axios.create({
      baseURL,
      headers: baseHeaders,
      // axios tries to parse anything and everythin to JSON,
      // but we want to receive the response as text and parse on demand later
      // NOTE: responseType: 'text' does NOT work https://github.com/axios/axios/issues/907
      transformResponse: text => text,
    })
  }

  /** Makes an HTTP GET request to the specified `endpoint`. */
  async get(endpoint: string, options?: RequestOptions) {
    return await this.request('GET', endpoint, options)
  }

  /** Makes an HTTP POST request to the specified `endpoint`. */
  async post<T extends RequestOptions>(endpoint: string, options?: T): Promise<HttpResponse<T>> {
    return await this.request('POST', endpoint, options)
  }

  private async request<T extends RequestOptions>(
    method: Method,
    endpoint: string,
    options?: T
  ): Promise<HttpResponse<T>> {
    const url = this.makeUrl(endpoint, options?.query)
    const data = (() => {
      // return FormData as is
      if (options?.body instanceof FormData) return options.body
      // serialize object to JSON
      if (options?.body) return JSON.stringify(options.body)
      // undefined if no body
      return undefined
    })()
    const headers = options?.headers ?? {}
    if (options?.body instanceof FormData) {
      headers['Content-Type'] = 'multipart/form-data'
    } else if (options?.body) {
      headers['Content-Type'] = 'application/json'
    }

    try {
      const response = await this.client.request({
        url,
        method,
        headers,
        data,
        responseType: options?.streamResponse ? 'stream' : 'text',
        timeout: options?.timeout
      })

      if (options?.streamResponse) {
        // response requested as a stream
        return ok(response.data) as HttpResponse<T>
      }

      // response requested as text
      return ok(response.data) as HttpResponse<T>
    } catch (e) {
      const error = (() => {
        if (e instanceof AxiosError) return HttpError.fromAxiosError(e)
        if (e instanceof Error) return HttpError.fromError(e)
        return HttpError.fromMessage('An unexpected error occurred while making an HTTP request.')
      })()
      return err(error) as HttpResponse<T>
    }
  }

  private makeUrl(endpoint: string, query?: Record<string, any> | URLSearchParams): string {
    // convert query, if present, from object to string
    const q = (query instanceof URLSearchParams ? query : new URLSearchParams(query)).toString()
    // append query to url, if present, otherwise return the url without the question mark
    return q ? `${endpoint}?${q}` : endpoint
  }
}

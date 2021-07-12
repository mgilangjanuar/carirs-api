import express, { Router } from 'express'
import { CariRS } from 'carirs'
import { Request, Response } from 'express-serve-static-core'
import { NextFunction } from 'connect'
import Redis from 'ioredis'

const app = express()
const cariRS = new CariRS()
const redis = new Redis({ keyPrefix: 'carirs' })

async function getFromCacheFirst<T = any>(key: string, fn: () => Promise<T> | T, sec: number = 1) {
  const data = await redis.get(key)
  if (key) return JSON.parse(data)
  const result = await fn()
  await redis.set(key, JSON.stringify(result), 'EX', sec)
  return result
}

app.get('/', (_, res) => {
  return res.send({
    '/ping': {
      method: 'get',
      details: 'health checker'
    },
    '/api/v1/provinces': {
      method: 'get',
      details: 'get list of provinces',
      query: [{ q: 'optional' }],
      examples: [
        '/api/v1/provinces?q=jakarta'
      ]
    },
    '/api/v1/cities': {
      method: 'get',
      details: 'get list of cities',
      query: [{ q: 'optional', provinceId: 'optional' }],
      examples: [
        '/api/v1/cities?q=jakarta%20pusat',
        '/api/v1/cities?provinceId=31prop'
      ]
    },
    '/api/v1/hospitals': {
      method: 'get',
      details: 'get list of hospitals',
      query: [{
        q: 'required if no `provinceId`',
        type: 'required if no `q`',
        provinceId: 'required if no `q`',
        cityId: 'optional'
      }],
      examples: [
        '/api/v1/hospitals?q=rsup%20fatmawati',
        '/api/v1/hospitals?q=jagakarsa&type=covid',
        '/api/v1/hospitals?type=noncovid&provinceId=31prop',
        '/api/v1/hospitals?type=covid&provinceId=31prop&cityId=3171'
      ]
    },
    '/api/v1/bedDetails': {
      method: 'get',
      details: 'get list of bed details',
      query: [{
        type: 'required',
        hospitalId: 'required'
      }],
      examples: [
        '/api/v1/bedDetails?type=covid&hospitalId=3171793'
      ]
    },
    '/api/v1/maps': {
      method: 'get',
      details: 'get maps of hospital',
      query: [{
        hospitalId: 'required'
      }],
      examples: [
        '/api/v1/maps?hospitalId=3171793'
      ]
    }
  })
})

app.get('/ping', (_, res) => res.send({ pong: true }))

app.use('/api/v1', (() => {
  const router = Router()

  router.get('/provinces', async (req, res) => {
    const { q } = req.query
    const data = await getFromCacheFirst(`provinces:${q || 'null'}`, () => {
      if (q) {
        return cariRS.findProvinces(q as string)
      }
      return cariRS.getProvinces()
    }, 86400)
    return res.send(data)
  })

  router.get('/cities', async (req, res) => {
    const { provinceId, q } = req.query
    const data = await getFromCacheFirst(`cities:${provinceId || 'null'}:${q || 'null'}`, () => {
      if (provinceId) {
        return cariRS.getCities(provinceId as string)
      }
      return cariRS.findCities(q as string)
    }, 86400)
    return res.send(data)
  })

  router.get('/hospitals', async (req, res, next) => {
    const { type, provinceId, cityId, q } = req.query
    if (type && type !== 'covid' && type !== 'noncovid') {
      return next({ status: 400, body: { error: 'Parameter type is only for `covid` or `noncovid`' } })
    }
    try {
      const data = await getFromCacheFirst(`hospitals:${type || 'null'}:${provinceId || 'null'}:${cityId || 'null'}:${q || null}`, async () => {
        if (q) {
          return {
            info: 'The data is static and not returned the total and available rooms, use parameters `provinceId` and `type` to view the real-time data.',
            ...cariRS.findHospitals(q as string, type as 'covid' | 'noncovid' | undefined)
          }
        }
        if (!type || !provinceId) {
          throw { status: 400, body: { error: '`type` and `provinceId` are required in URL parameter.' } }
        }
        return await cariRS.getHospitals(type as 'covid' | 'noncovid', provinceId as string, cityId as string)
      }, 600)
      return res.send(data)
    } catch ({ status, body }) {
      return next({ status, body })
    }
  })

  router.get('/bedDetails', async (req, res, next) => {
    const { type, hospitalId } = req.query
    if (!type || !hospitalId) {
      return next({ status: 400, body: { error: '`type` and `hospitalId` are required' } })
    }
    const data = await getFromCacheFirst(`bedDetails:${type}:${hospitalId}`, async () => {
      return await cariRS.getBedDetails(type as 'covid' | 'noncovid', hospitalId as string)
    }, 600)
    return res.send(data)
  })

  router.get('/maps', async (req, res, next) => {
    const { hospitalId } = req.query
    if (!hospitalId) {
      return next({ status: 400, body: { error: '`hospitalId` id required' } })
    }
    const data = await getFromCacheFirst(`maps:${hospitalId}`, async () => {
      return await cariRS.getMaps(hospitalId as string)
    }, 86400)
    return res.send(data)
  })

  return router
})())

app.use((err: { status: number, body: Record<string, unknown> }, _: Request, res: Response, next: NextFunction) => {
  if (err?.status) {
    return res.status(err.status).send(err.body || { error: 'Something error' })
  }
  return next()
})

app.use((_, res) => res.status(404).send({ error: 'Not found' }))

app.listen(process.env.PORT || 4000, () => console.log(`Starting app at :${process.env.PORT || '4000'}...`))
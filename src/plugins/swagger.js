// src/plugins/swagger.js
// Configures OpenAPI/Swagger and Swagger UI for Fastify

import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

async function swaggerPlugin(fastify, options) {
  // Register the core swagger generator
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Street Arcade API',
        description: 'Backend API for DreamBricks Street Arcade operations, totems, and session management.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Totems', description: 'Totem management and queue endpoints' },
        { name: 'Sessions', description: 'Game session lifecycle management' },
      ],
      components: {
        securitySchemes: {
          // If we add API keys or JWT later, it goes here
        }
      }
    }
  })

  // Register the Swagger UI to serve the documentation
  await fastify.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false
    },
    uiHooks: {
      onRequest: function (request, reply, next) { next() },
      preHandler: function (request, reply, next) { next() }
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, request, reply) => { return swaggerObject },
    transformSpecificationClone: true
  })
}

export default fp(swaggerPlugin, {
  name: 'swagger'
})

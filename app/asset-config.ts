// Asset compilation settings for the Worker build used in development and deployment.
export const assetConfig = {
  basePath: '/assets',
  allowFiles: ['app/routes.ts', 'app/**/public/**'],
  allowPackages: ['remix'],
}

export const browserEntry = 'app/actions/public/entry.ts'

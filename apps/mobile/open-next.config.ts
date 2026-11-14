// OpenNext on Cloudflare Workers. The pages are static shells that call the API from the browser,
// so no incremental cache (R2) or image optimisation is needed.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();

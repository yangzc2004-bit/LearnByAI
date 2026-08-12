import { GenerationJob } from "./types";

export function publicGenerationJob(job: GenerationJob): GenerationJob {
  const publicJob = { ...job };
  delete publicJob.modelOverrides;
  delete publicJob.planningCheckpoint;
  return publicJob;
}

export function publicGenerationJobs(jobs: GenerationJob[]): GenerationJob[] {
  return jobs.map(publicGenerationJob);
}

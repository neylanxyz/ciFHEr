import { createContext, useContext, useState, ReactNode } from 'react'

interface WorkerBusyContextValue {
  workerBusy: boolean
  workerTask: string | null
  beginWorkerTask: (task: string) => void
  endWorkerTask: () => void
}

const WorkerBusyContext = createContext<WorkerBusyContextValue>({
  workerBusy: false,
  workerTask: null,
  beginWorkerTask: () => {},
  endWorkerTask: () => {},
})

export function WorkerBusyProvider({ children }: { children: ReactNode }) {
  const [workerTask, setWorkerTask] = useState<string | null>(null)

  function beginWorkerTask(task: string) { setWorkerTask(task) }
  function endWorkerTask() { setWorkerTask(null) }

  return (
    <WorkerBusyContext.Provider value={{ workerBusy: workerTask !== null, workerTask, beginWorkerTask, endWorkerTask }}>
      {children}
    </WorkerBusyContext.Provider>
  )
}

export function useWorkerBusy() {
  return useContext(WorkerBusyContext)
}

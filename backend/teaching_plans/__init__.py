"""Teaching plans: what each node is responsible for teaching, saved once and reused by lessons and chat.

A plan says what new ability a node gives the learner, what it must teach in full, what it only borrows
from earlier nodes, what it leaves for other nodes to deepen, and how it differs from related nodes that
touch the same idea. Plans organise teaching; they never count as evidence that the learner knows
anything, so questions and assessments never see them.

Modules:
- scope: where plans live (one book per review scope) and the scoped view of a node.
- neighbours: which related nodes a plan must be coordinated with.
- inputs: the planning inputs, and the narrower inputs whose change makes a plan stale.
- schema / prompt / validate: the AI contract, its instructions and the checks on its reply.
- planner: the AI task that prepares or updates one node's plan.
- projection: what lessons, chat and the client see of the plans.
- routes: the HTTP endpoints.
"""

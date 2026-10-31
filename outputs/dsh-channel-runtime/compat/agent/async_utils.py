import asyncio
import functools

async def offload_blocking(function, *args, **kwargs):
    return await asyncio.to_thread(functools.partial(function, *args, **kwargs))

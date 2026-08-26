models/weaphits/proxflare
{
	deformVertexes autosprite
	{
		map textures/flares/wide.tga
		blendfunc add
		rgbGen const ( 1 0 0 )
	}
}

models/weaphits/proxflare_b
{
	deformVertexes autosprite
	{
		map textures/flares/flarey.tga
		blendfunc add
		rgbGen const ( 0 0 1 )
	}
}

models/weaphits/proxlite
{
	cull disable
	{
		map models/weaphits/proxbomb.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
	}
}

models/weaphits/proxlite_b
{
	cull disable
	{
		map models/weaphits/proxbomb_b.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
	}
}


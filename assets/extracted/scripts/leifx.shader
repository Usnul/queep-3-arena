//Various subtle smoke effects, animated, designed to trail things and come off walls
leismoke1
{
	{
		clampmap sprites/le/smoke1.tga
		blendfunc blend
		rgbGen Vertex
		alphaGen Vertex
	}
}

leismoke2
{
	{
		clampmap sprites/le/smoke2.tga
		blendfunc blend
		rgbGen Vertex
		alphaGen Vertex
	}
}

leismoke3
{
	{
		clampmap sprites/le/smoke3.tga
		blendfunc blend
		rgbGen Vertex
		alphaGen Vertex
	}
}

leismoke4
{
	{
		clampmap sprites/le/smoke4.tga
		blendfunc blend
		rgbGen Vertex
		alphaGen Vertex
	}
}

plasmaSpark
{
	cull disable
	{
		clampmap models/weaphits/lfx/plasmazot.tga
		blendfunc add
		rgbGen Vertex
		tcMod rotate -400
	}
}

exploShockwave
{
	cull disable
	{
		clampmap models/weaphits/lfx/swavecirc.tga
		blendfunc gl_src_alpha gl_one
		rgbGen Vertex
		tcMod rotate 96
		alphaGen Vertex
	}
	{
		clampmap models/weaphits/lfx/swavecirc.tga
		blendfunc gl_src_alpha gl_one
		rgbGen Vertex
		tcMod rotate -6
		alphaGen Vertex
	}
}

//Splash effect for bullets entering the water
leisplash
{
	{
		clampmap sprites/le/splash.tga
		blendfunc add
		rgbGen Vertex
		tcMod stretch sin 0.7 0 0 1 
		alphaFunc GE128
		alphaGen Vertex
	}
}

//Boom sparks from explosions
leiboom1
{
	{
		clampmap sprites/le/blast.tga
		blendfunc add
		rgbGen identity
	}
}

//Blood particle (from trailing gib or impact of bullet)
leiblood1
{
	{
		clampmap sprites/le/blood.tga
		blendfunc blend
		tcMod stretch sin 0.7 0 0 1 
		alphaGen Vertex
	}
}

//Mark for blood particle
leiblood2
{
	polygonoffset
	{
		clampmap sprites/le/blood3.tga
		blendfunc gl_zero gl_one_minus_src_color
		rgbGen identity
	}
}

//preliminary fireball boom
leifball
{
	{
		clampmap sprites/le/glaw.tga
		blendfunc add
		rgbGen identity
	}
}

//plasma trail
leiptrail
{
	{
		clampmap sprites/le/ptrail.tga
		blendfunc gl_src_alpha gl_one
		rgbGen const ( 0.713726 0.819608 0.913726 )
		tcMod stretch sin 0.6 0 0 1 
		tcMod rotate -22
		alphaFunc GE128
	}
	{
		clampmap sprites/le/ptrail.tga
		blendfunc gl_src_alpha gl_one
		rgbGen const ( 0.337255 0.4 0.611765 )
		tcMod stretch sin 0.8 0 0 1 
		tcMod rotate 6
	}
}

// The crap that comes out of walls
leispark
{
	{
		clampmap sprites/le/spark2.tga
		blendfunc gl_src_alpha gl_one
		rgbGen identity
	}
}

// Metal Crap is brighter
leispark2
{
	{
		clampmap sprites/le/spark2.tga
		blendfunc gl_src_alpha gl_one
		rgbGen identity
		tcMod stretch sin 0.4 0.3 0 5 
		alphaGen Vertex
	}
	{
		clampmap sprites/le/spark2.tga
		blendfunc gl_src_alpha gl_one
		rgbGen identity
		tcMod stretch sin 0.7 0.3 0 3 
		alphaGen Vertex
	}
}

//Fake texture atlas trick ahead!
leimetalmark1
{
	polygonoffset
	{
		map gfx/fx/decals/bulletmetal.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale 0.5 0.5
	}
}

leimetalmark2
{
	polygonoffset
	{
		map gfx/fx/decals/bulletmetal.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale -0.5 0.5
	}
}

leimetalmark3
{
	polygonoffset
	{
		map gfx/fx/decals/bulletmetal.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale -0.5 -0.5
	}
}

leimetalmark4
{
	polygonoffset
	{
		map gfx/fx/decals/bulletmetal.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale 0.5 -0.5
	}
}

leibulletmark1
{
	polygonoffset
	{
		map gfx/fx/decals/bulletgeneric.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale 0.5 0.5
	}
}

leibulletmark2
{
	polygonoffset
	{
		map gfx/fx/decals/bulletgeneric.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale -0.5 0.5
	}
}

leibulletmark3
{
	polygonoffset
	{
		map gfx/fx/decals/bulletgeneric.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale 0.5 -0.5
	}
}

leibulletmark4
{
	polygonoffset
	{
		map gfx/fx/decals/bulletgeneric.tga
		blendfunc gl_dst_color gl_src_color
		rgbGen identity
		tcMod scale -0.5 -0.5
	}
}

